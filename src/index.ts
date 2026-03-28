import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  ECHO_API_KEY: string;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

// --- Helpers ---
function uid(): string { return crypto.randomUUID(); }
function sanitize(s: string, max = 2000): string { return (s || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max); }
function sanitizeBody(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? sanitize(v) : v;
  }
  return out;
}

interface RLState { c: number; t: number; }
async function rateLimit(kv: KVNamespace, key: string, limit: number, windowSec = 60): Promise<boolean> {
  const now = Date.now();
  const raw = await kv.get<RLState>(`rl:${key}`, 'json');
  if (!raw || (now - raw.t) > windowSec * 1000) {
    await kv.put(`rl:${key}`, JSON.stringify({ c: 1, t: now }), { expirationTtl: windowSec * 2 });
    return true;
  }
  const elapsed = (now - raw.t) / 1000;
  const decayed = raw.c * Math.max(0, 1 - elapsed / windowSec);
  const newCount = decayed + 1;
  if (newCount > limit) return false;
  await kv.put(`rl:${key}`, JSON.stringify({ c: newCount, t: now }), { expirationTtl: windowSec * 2 });
  return true;
}

// CORS
app.use('*', cors());

// --- Auth middleware ---
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/health' || path === '/status' || c.req.method === 'GET') return next();
  if (path.startsWith('/webhook/trigger/')) return next(); // Public webhook triggers
  const key = c.req.header('X-Echo-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!key || key !== c.env.ECHO_API_KEY) return c.json({ error: 'Unauthorized' }, 401);
  return next();
});

// --- Rate limiting ---
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/health' || path === '/status') return next();
  const tenant = c.req.header('X-Tenant-ID') || c.req.query('tenant_id') || 'default';
  const limit = c.req.method === 'GET' ? 200 : 60;
  if (!(await rateLimit(c.env.CACHE, `${tenant}:${c.req.method}`, limit))) {
    return c.json({ error: 'Rate limited' }, 429);
  }
  return next();
});

// ── Health ──
app.get('/', (c) => c.redirect('/health'));
app.get('/health', (c) => c.json({ ok: true, service: 'echo-workflow-automation', version: '1.0.0', timestamp: new Date().toISOString() }));
app.get('/status', async (c) => {
  const stats = await c.env.DB.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status=\'active\' THEN 1 ELSE 0 END) as active FROM workflows').first<{total:number;active:number}>();
  const runs = await c.env.DB.prepare('SELECT COUNT(*) as total FROM workflow_runs WHERE started_at > datetime(\'now\',\'-24 hours\')').first<{total:number}>();
  return c.json({ ok: true, workflows: stats?.total || 0, active: stats?.active || 0, runs_24h: runs?.total || 0 });
});

// ── Tenants ──
app.post('/tenants', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO tenants (id,name,plan,webhook_secret) VALUES (?,?,?,?)').bind(id, b.name || 'Default', b.plan || 'starter', uid()).run();
  return c.json({ id });
});
app.get('/tenants/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(c.req.param('id')).first();
  return r ? c.json(r) : c.json({ error: 'Not found' }, 404);
});

// ── Connections (service integrations) ──
app.get('/connections', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const rows = await c.env.DB.prepare('SELECT id,tenant_id,service_name,display_name,auth_type,status,last_used_at,created_at FROM connections WHERE tenant_id=?').bind(tid).all();
  return c.json({ connections: rows.results });
});
app.post('/connections', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO connections (id,tenant_id,service_name,display_name,auth_type,credentials_json) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,service_name) DO UPDATE SET display_name=excluded.display_name, auth_type=excluded.auth_type, credentials_json=excluded.credentials_json, status=\'active\'')
    .bind(id, b.tenant_id, b.service_name, b.display_name || b.service_name, b.auth_type || 'api_key', JSON.stringify(b.credentials || {})).run();
  return c.json({ id });
});
app.delete('/connections/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM connections WHERE id=?').bind(c.req.param('id')).run();
  return c.json({ deleted: true });
});

// ── Echo Services catalog (built-in integrations) ──
const ECHO_SERVICES = [
  { name: 'echo-crm', label: 'Echo CRM', actions: ['create_contact','update_deal','add_note','score_lead'] },
  { name: 'echo-helpdesk', label: 'Echo Helpdesk', actions: ['create_ticket','assign_ticket','add_message','close_ticket'] },
  { name: 'echo-invoice', label: 'Echo Invoice', actions: ['create_invoice','send_invoice','record_payment','generate_reminder'] },
  { name: 'echo-email-marketing', label: 'Echo Email Marketing', actions: ['add_contact','send_campaign','create_automation'] },
  { name: 'echo-booking', label: 'Echo Booking', actions: ['create_appointment','cancel_appointment','check_availability'] },
  { name: 'echo-forms', label: 'Echo Forms', actions: ['get_responses','create_form','export_data'] },
  { name: 'echo-lms', label: 'Echo LMS', actions: ['enroll_student','create_course','update_progress'] },
  { name: 'echo-inventory', label: 'Echo Inventory', actions: ['update_stock','create_po','check_levels','transfer_stock'] },
  { name: 'echo-hr', label: 'Echo HR', actions: ['create_employee','approve_leave','run_payroll'] },
  { name: 'echo-contracts', label: 'Echo Contracts', actions: ['create_contract','send_for_signing','check_expiry'] },
  { name: 'echo-surveys', label: 'Echo Surveys', actions: ['create_survey','get_responses','analyze_nps'] },
  { name: 'echo-knowledge-base', label: 'Echo Knowledge Base', actions: ['create_article','search_articles','get_feedback'] },
  { name: 'echo-project-manager', label: 'Echo Project Manager', actions: ['create_task','update_status','add_time_entry'] },
  { name: 'echo-finance-ai', label: 'Echo Finance AI', actions: ['add_transaction','check_budget','analyze_spending'] },
  { name: 'echo-home-ai', label: 'Echo Home AI', actions: ['control_device','set_routine','check_status'] },
  { name: 'echo-email-sender', label: 'Echo Email Sender', actions: ['send_email','send_template'] },
  { name: 'echo-chat', label: 'Echo Chat', actions: ['send_message','query_ai'] },
  { name: 'echo-engine-runtime', label: 'Engine Runtime', actions: ['query_engine','list_engines'] },
];
app.get('/services', (c) => c.json({ services: ECHO_SERVICES }));

// ── Workflows CRUD ──
app.get('/workflows', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const status = c.req.query('status');
  let sql = 'SELECT * FROM workflows WHERE tenant_id=?';
  const params: string[] = [tid];
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY updated_at DESC';
  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ workflows: rows.results });
});

app.get('/workflows/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(c.req.param('id')).first();
  return r ? c.json(r) : c.json({ error: 'Not found' }, 404);
});

app.post('/workflows', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const tid = b.tenant_id || 'default';
  // Check tenant workflow limit
  const count = await c.env.DB.prepare('SELECT COUNT(*) as c FROM workflows WHERE tenant_id=?').bind(tid).first<{c:number}>();
  const tenant = await c.env.DB.prepare('SELECT max_workflows FROM tenants WHERE id=?').bind(tid).first<{max_workflows:number}>();
  const max = tenant?.max_workflows || 10;
  if ((count?.c || 0) >= max) return c.json({ error: `Workflow limit reached (${max})` }, 400);

  const id = uid();
  await c.env.DB.prepare('INSERT INTO workflows (id,tenant_id,name,description,trigger_type,trigger_config,steps_json,error_handling,tags) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, tid, b.name || 'Untitled', b.description || '', b.trigger_type || 'manual', JSON.stringify(b.trigger_config || {}), JSON.stringify(b.steps || []), b.error_handling || 'stop', b.tags || '').run();

  // If webhook trigger, create webhook
  if (b.trigger_type === 'webhook') {
    const path = `wh-${id.slice(0, 8)}`;
    await c.env.DB.prepare('INSERT INTO webhooks (id,tenant_id,workflow_id,path,method) VALUES (?,?,?,?,?)').bind(uid(), tid, id, path, b.trigger_config?.method || 'POST').run();
  }
  // If schedule trigger, create scheduled run
  if (b.trigger_type === 'schedule' && b.trigger_config?.cron) {
    await c.env.DB.prepare('INSERT INTO scheduled_runs (id,workflow_id,tenant_id,cron_expression,next_run_at) VALUES (?,?,?,?,datetime(\'now\',\'+1 hour\'))').bind(uid(), id, tid, b.trigger_config.cron).run();
  }

  return c.json({ id });
});

app.put('/workflows/:id', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const sets: string[] = [];
  const vals: any[] = [];
  if (b.name !== undefined) { sets.push('name=?'); vals.push(b.name); }
  if (b.description !== undefined) { sets.push('description=?'); vals.push(b.description); }
  if (b.steps) { sets.push('steps_json=?'); vals.push(JSON.stringify(b.steps)); }
  if (b.trigger_config) { sets.push('trigger_config=?'); vals.push(JSON.stringify(b.trigger_config)); }
  if (b.error_handling) { sets.push('error_handling=?'); vals.push(b.error_handling); }
  if (b.tags !== undefined) { sets.push('tags=?'); vals.push(b.tags); }
  if (sets.length === 0) return c.json({ error: 'No fields to update' }, 400);
  sets.push('updated_at=datetime(\'now\')');
  vals.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE workflows SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
  return c.json({ updated: true });
});

app.delete('/workflows/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM workflows WHERE id=?').bind(id),
    c.env.DB.prepare('DELETE FROM webhooks WHERE workflow_id=?').bind(id),
    c.env.DB.prepare('DELETE FROM scheduled_runs WHERE workflow_id=?').bind(id),
  ]);
  return c.json({ deleted: true });
});

// ── Workflow activation ──
app.post('/workflows/:id/activate', async (c) => {
  await c.env.DB.prepare('UPDATE workflows SET status=\'active\', updated_at=datetime(\'now\') WHERE id=?').bind(c.req.param('id')).run();
  await c.env.DB.prepare('UPDATE webhooks SET is_active=1 WHERE workflow_id=?').bind(c.req.param('id')).run();
  await c.env.DB.prepare('UPDATE scheduled_runs SET is_active=1 WHERE workflow_id=?').bind(c.req.param('id')).run();
  return c.json({ activated: true });
});
app.post('/workflows/:id/pause', async (c) => {
  await c.env.DB.prepare('UPDATE workflows SET status=\'paused\', updated_at=datetime(\'now\') WHERE id=?').bind(c.req.param('id')).run();
  await c.env.DB.prepare('UPDATE webhooks SET is_active=0 WHERE workflow_id=?').bind(c.req.param('id')).run();
  await c.env.DB.prepare('UPDATE scheduled_runs SET is_active=0 WHERE workflow_id=?').bind(c.req.param('id')).run();
  return c.json({ paused: true });
});

// ── Manual trigger ──
app.post('/workflows/:id/run', async (c) => {
  const wf = await c.env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(c.req.param('id')).first<any>();
  if (!wf) return c.json({ error: 'Workflow not found' }, 404);

  // Check daily run limit
  const today = await c.env.DB.prepare('SELECT COUNT(*) as c FROM workflow_runs WHERE tenant_id=? AND started_at > datetime(\'now\',\'-24 hours\')').bind(wf.tenant_id).first<{c:number}>();
  const tenant = await c.env.DB.prepare('SELECT max_runs_per_day FROM tenants WHERE id=?').bind(wf.tenant_id).first<{max_runs_per_day:number}>();
  const maxRuns = tenant?.max_runs_per_day || 100;
  if ((today?.c || 0) >= maxRuns) return c.json({ error: `Daily run limit reached (${maxRuns})` }, 429);

  const b = await c.req.json().catch(() => ({}));
  const runId = uid();
  const steps = JSON.parse(wf.steps_json || '[]');
  await c.env.DB.prepare('INSERT INTO workflow_runs (id,workflow_id,tenant_id,status,trigger_data,steps_total) VALUES (?,?,?,\'running\',?,?)')
    .bind(runId, wf.id, wf.tenant_id, JSON.stringify(b), steps.length).run();

  // Execute steps synchronously (simple engine)
  const result = await executeWorkflow(c.env, wf, runId, steps, b);
  return c.json({ run_id: runId, ...result });
});

// ── Webhook trigger (public) ──
app.all('/webhook/trigger/:path', async (c) => {
  const wh = await c.env.DB.prepare('SELECT * FROM webhooks WHERE path=? AND is_active=1').bind(c.req.param('path')).first<any>();
  if (!wh) return c.json({ error: 'Webhook not found' }, 404);

  const wf = await c.env.DB.prepare('SELECT * FROM workflows WHERE id=? AND status=\'active\'').bind(wh.workflow_id).first<any>();
  if (!wf) return c.json({ error: 'Workflow not active' }, 404);

  // Rate limit webhooks per path
  if (!(await rateLimit(c.env.CACHE, `wh:${wh.path}`, 30))) return c.json({ error: 'Rate limited' }, 429);

  const body = await c.req.json().catch(() => ({}));
  const runId = uid();
  const steps = JSON.parse(wf.steps_json || '[]');
  await c.env.DB.prepare('INSERT INTO workflow_runs (id,workflow_id,tenant_id,status,trigger_data,steps_total) VALUES (?,?,?,\'running\',?,?)')
    .bind(runId, wf.id, wf.tenant_id, JSON.stringify(body), steps.length).run();

  // Update webhook stats
  await c.env.DB.prepare('UPDATE webhooks SET last_triggered_at=datetime(\'now\'), trigger_count=trigger_count+1 WHERE id=?').bind(wh.id).run();

  const result = await executeWorkflow(c.env, wf, runId, steps, body);
  return c.json({ run_id: runId, ...result });
});

// ── Workflow execution engine ──
async function executeWorkflow(env: Env, wf: any, runId: string, steps: any[], triggerData: any): Promise<{status: string; steps_executed: number; output?: any; error?: string}> {
  let context: Record<string, any> = { trigger: triggerData, steps: {} };
  let stepsExecuted = 0;
  const startMs = Date.now();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepLogId = uid();
    const stepStart = Date.now();
    await env.DB.prepare('INSERT INTO step_logs (id,run_id,workflow_id,step_index,step_type,step_name,status,input_data) VALUES (?,?,?,?,?,?,\'running\',?)')
      .bind(stepLogId, runId, wf.id, i, step.type || 'http', step.name || `Step ${i+1}`, JSON.stringify(step)).run();

    try {
      // Condition check
      if (step.type === 'condition') {
        const field = resolveTemplate(step.field || '', context);
        const op = step.operator || 'equals';
        const value = step.value;
        let passes = false;
        if (op === 'equals') passes = field === value;
        else if (op === 'not_equals') passes = field !== value;
        else if (op === 'contains') passes = String(field).includes(String(value));
        else if (op === 'gt') passes = Number(field) > Number(value);
        else if (op === 'lt') passes = Number(field) < Number(value);
        else if (op === 'exists') passes = field !== undefined && field !== null && field !== '';
        else if (op === 'not_exists') passes = !field;

        if (!passes) {
          // Skip to the step after the else_step (if defined) or skip remaining
          await env.DB.prepare('UPDATE step_logs SET status=\'skipped\', output_data=?, duration_ms=?, completed_at=datetime(\'now\') WHERE id=?')
            .bind(JSON.stringify({ condition: false }), Date.now() - stepStart, stepLogId).run();
          if (step.skip_to !== undefined) { i = step.skip_to - 1; continue; }
          continue;
        }
        context.steps[`step_${i}`] = { condition: true };
        await env.DB.prepare('UPDATE step_logs SET status=\'completed\', output_data=?, duration_ms=?, completed_at=datetime(\'now\') WHERE id=?')
          .bind(JSON.stringify({ condition: true }), Date.now() - stepStart, stepLogId).run();
        stepsExecuted++;
        continue;
      }

      // Delay
      if (step.type === 'delay') {
        const ms = Math.min((step.seconds || 1) * 1000, 5000); // max 5s
        await new Promise(r => setTimeout(r, ms));
        context.steps[`step_${i}`] = { delayed: ms };
        await env.DB.prepare('UPDATE step_logs SET status=\'completed\', output_data=?, duration_ms=?, completed_at=datetime(\'now\') WHERE id=?')
          .bind(JSON.stringify({ delayed_ms: ms }), Date.now() - stepStart, stepLogId).run();
        stepsExecuted++;
        continue;
      }

      // Transform (JavaScript-like data mapping)
      if (step.type === 'transform') {
        const output: Record<string, any> = {};
        for (const [key, template] of Object.entries(step.mapping || {})) {
          output[key] = resolveTemplate(String(template), context);
        }
        context.steps[`step_${i}`] = output;
        await env.DB.prepare('UPDATE step_logs SET status=\'completed\', output_data=?, duration_ms=?, completed_at=datetime(\'now\') WHERE id=?')
          .bind(JSON.stringify(output), Date.now() - stepStart, stepLogId).run();
        stepsExecuted++;
        continue;
      }

      // HTTP request
      if (step.type === 'http') {
        const url = resolveTemplate(step.url || '', context);
        const method = step.method || 'POST';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (step.headers) {
          for (const [k, v] of Object.entries(step.headers)) {
            headers[k] = resolveTemplate(String(v), context);
          }
        }
        const bodyStr = step.body ? JSON.stringify(resolveTemplateObj(step.body, context)) : undefined;
        const resp = await fetch(url, { method, headers, body: method !== 'GET' ? bodyStr : undefined });
        const respData = await resp.json().catch(() => ({ status: resp.status }));
        context.steps[`step_${i}`] = respData;
        await env.DB.prepare('UPDATE step_logs SET status=\'completed\', output_data=?, duration_ms=?, completed_at=datetime(\'now\') WHERE id=?')
          .bind(JSON.stringify(respData).slice(0, 10000), Date.now() - stepStart, stepLogId).run();
        stepsExecuted++;
        continue;
      }

      // Echo service action (built-in integration)
      if (step.type === 'echo_service') {
        const service = step.service || '';
        const action = step.action || '';
        const params = resolveTemplateObj(step.params || {}, context);
        // Route to the appropriate Echo service
        const url = `https://${service}.bmcii1976.workers.dev/${action.replace(/_/g, '-')}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Echo-API-Key': step.api_key || '' },
          body: JSON.stringify(params),
        });
        const respData = await resp.json().catch(() => ({ status: resp.status }));
        context.steps[`step_${i}`] = respData;
        await env.DB.prepare('UPDATE step_logs SET status=\'completed\', output_data=?, duration_ms=?, completed_at=datetime(\'now\') WHERE id=?')
          .bind(JSON.stringify(respData).slice(0, 10000), Date.now() - stepStart, stepLogId).run();
        stepsExecuted++;
        continue;
      }

      // AI step (Engine Runtime query)
      if (step.type === 'ai') {
        const prompt = resolveTemplate(step.prompt || '', context);
        const engineId = step.engine_id || 'GEN-01';
        const resp = await env.ENGINE_RUNTIME.fetch('https://engine/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine_id: engineId, query: prompt }),
        });
        const respData = await resp.json().catch(() => ({ error: 'Engine query failed' }));
        context.steps[`step_${i}`] = respData;
        await env.DB.prepare('UPDATE step_logs SET status=\'completed\', output_data=?, duration_ms=?, completed_at=datetime(\'now\') WHERE id=?')
          .bind(JSON.stringify(respData).slice(0, 10000), Date.now() - stepStart, stepLogId).run();
        stepsExecuted++;
        continue;
      }

      // Unknown step type
      throw new Error(`Unknown step type: ${step.type}`);

    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error';
      await env.DB.prepare('UPDATE step_logs SET status=\'failed\', error_message=?, duration_ms=?, completed_at=datetime(\'now\') WHERE id=?')
        .bind(errorMsg.slice(0, 500), Date.now() - stepStart, stepLogId).run();

      if (wf.error_handling === 'skip') { stepsExecuted++; continue; }
      if (wf.error_handling === 'retry') {
        // Simple retry (max 2)
        let retried = false;
        for (let r = 0; r < Math.min(wf.max_retries || 2, 2); r++) {
          await new Promise(res => setTimeout(res, 500));
          try {
            // Re-execute (simplified — just retry HTTP steps)
            if (step.type === 'http') {
              const url = resolveTemplate(step.url || '', context);
              const resp = await fetch(url, { method: step.method || 'POST', headers: { 'Content-Type': 'application/json' }, body: step.body ? JSON.stringify(resolveTemplateObj(step.body, context)) : undefined });
              const respData = await resp.json().catch(() => ({}));
              context.steps[`step_${i}`] = respData;
              retried = true;
              break;
            }
          } catch { continue; }
        }
        if (retried) { stepsExecuted++; continue; }
      }

      // Stop on error
      const dur = Date.now() - startMs;
      await env.DB.prepare('UPDATE workflow_runs SET status=\'failed\', steps_executed=?, current_step=?, error_message=?, error_step=?, duration_ms=?, completed_at=datetime(\'now\'), output_data=? WHERE id=?')
        .bind(stepsExecuted, i, errorMsg.slice(0, 500), i, dur, JSON.stringify(context.steps), runId).run();
      await env.DB.prepare('UPDATE workflows SET last_run_at=datetime(\'now\'), run_count=run_count+1, failure_count=failure_count+1, updated_at=datetime(\'now\') WHERE id=?').bind(wf.id).run();
      return { status: 'failed', steps_executed: stepsExecuted, error: errorMsg };
    }
  }

  const dur = Date.now() - startMs;
  await env.DB.prepare('UPDATE workflow_runs SET status=\'completed\', steps_executed=?, duration_ms=?, completed_at=datetime(\'now\'), output_data=? WHERE id=?')
    .bind(stepsExecuted, dur, JSON.stringify(context.steps), runId).run();

  // Update workflow stats
  const avgQ = await env.DB.prepare('SELECT AVG(duration_ms) as avg FROM workflow_runs WHERE workflow_id=? AND status=\'completed\'').bind(wf.id).first<{avg:number}>();
  await env.DB.prepare('UPDATE workflows SET last_run_at=datetime(\'now\'), run_count=run_count+1, success_count=success_count+1, avg_duration_ms=?, updated_at=datetime(\'now\') WHERE id=?')
    .bind(Math.round(avgQ?.avg || dur), wf.id).run();

  return { status: 'completed', steps_executed: stepsExecuted, output: context.steps };
}

// Template resolution: {{trigger.field}} or {{steps.step_0.field}}
function resolveTemplate(template: string, context: Record<string, any>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
    const parts = path.trim().split('.');
    let val: any = context;
    for (const p of parts) { val = val?.[p]; }
    return val !== undefined ? String(val) : '';
  });
}
function resolveTemplateObj(obj: any, context: Record<string, any>): any {
  if (typeof obj === 'string') return resolveTemplate(obj, context);
  if (Array.isArray(obj)) return obj.map(v => resolveTemplateObj(v, context));
  if (obj && typeof obj === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveTemplateObj(v, context);
    return out;
  }
  return obj;
}

// ── Workflow Runs ──
app.get('/runs', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const wfId = c.req.query('workflow_id');
  const status = c.req.query('status');
  let sql = 'SELECT * FROM workflow_runs WHERE tenant_id=?';
  const params: string[] = [tid];
  if (wfId) { sql += ' AND workflow_id=?'; params.push(wfId); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY started_at DESC LIMIT 50';
  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ runs: rows.results });
});

app.get('/runs/:id', async (c) => {
  const run = await c.env.DB.prepare('SELECT * FROM workflow_runs WHERE id=?').bind(c.req.param('id')).first();
  if (!run) return c.json({ error: 'Not found' }, 404);
  const logs = await c.env.DB.prepare('SELECT * FROM step_logs WHERE run_id=? ORDER BY step_index').bind(c.req.param('id')).all();
  return c.json({ ...run, step_logs: logs.results });
});

// ── Templates ──
app.get('/templates', async (c) => {
  const cat = c.req.query('category');
  let sql = 'SELECT * FROM templates';
  const params: string[] = [];
  if (cat) { sql += ' WHERE category=?'; params.push(cat); }
  sql += ' ORDER BY use_count DESC';
  const rows = params.length ? await c.env.DB.prepare(sql).bind(...params).all() : await c.env.DB.prepare(sql).all();
  return c.json({ templates: rows.results });
});

app.post('/templates', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO templates (id,name,description,category,trigger_type,trigger_config,steps_json) VALUES (?,?,?,?,?,?,?)')
    .bind(id, b.name, b.description || '', b.category || 'general', b.trigger_type || 'manual', JSON.stringify(b.trigger_config || {}), JSON.stringify(b.steps || [])).run();
  return c.json({ id });
});

app.post('/templates/:id/use', async (c) => {
  const t = await c.env.DB.prepare('SELECT * FROM templates WHERE id=?').bind(c.req.param('id')).first<any>();
  if (!t) return c.json({ error: 'Not found' }, 404);
  await c.env.DB.prepare('UPDATE templates SET use_count=use_count+1 WHERE id=?').bind(t.id).run();
  return c.json({ trigger_type: t.trigger_type, trigger_config: JSON.parse(t.trigger_config || '{}'), steps: JSON.parse(t.steps_json || '[]') });
});

// ── Webhooks ──
app.get('/webhooks', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const rows = await c.env.DB.prepare('SELECT w.*, wf.name as workflow_name FROM webhooks w LEFT JOIN workflows wf ON w.workflow_id=wf.id WHERE w.tenant_id=?').bind(tid).all();
  return c.json({ webhooks: rows.results });
});

// ── Analytics ──
app.get('/analytics/overview', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const wfStats = await c.env.DB.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status=\'active\' THEN 1 ELSE 0 END) as active FROM workflows WHERE tenant_id=?').bind(tid).first<any>();
  const runStats = await c.env.DB.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status=\'completed\' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN status=\'failed\' THEN 1 ELSE 0 END) as failed, AVG(duration_ms) as avg_duration FROM workflow_runs WHERE tenant_id=? AND started_at > datetime(\'now\',\'-30 days\')').bind(tid).first<any>();
  const topWf = await c.env.DB.prepare('SELECT id,name,run_count,success_count,failure_count,avg_duration_ms FROM workflows WHERE tenant_id=? ORDER BY run_count DESC LIMIT 5').bind(tid).all();
  return c.json({ workflows: wfStats, runs_30d: runStats, top_workflows: topWf.results });
});

app.get('/analytics/runs', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const daily = await c.env.DB.prepare('SELECT date(started_at) as day, COUNT(*) as runs, SUM(CASE WHEN status=\'completed\' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN status=\'failed\' THEN 1 ELSE 0 END) as failed FROM workflow_runs WHERE tenant_id=? AND started_at > datetime(\'now\',\'-30 days\') GROUP BY day ORDER BY day').bind(tid).all();
  return c.json({ daily: daily.results });
});

// ── AI: Generate workflow from description ──
app.post('/ai/generate-workflow', async (c) => {
  const b = await c.req.json() as { description: string; tenant_id?: string };
  if (!b.description) return c.json({ error: 'description required' }, 400);
  const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine_id: 'GEN-01', query: `Generate a workflow automation definition as JSON with the following structure: { "name": "...", "trigger_type": "webhook|schedule|manual", "trigger_config": {}, "steps": [{ "type": "http|transform|condition|echo_service|ai|delay", "name": "...", ... }] }. The workflow should: ${b.description}. Available Echo services: ${ECHO_SERVICES.map(s => s.name).join(', ')}. Template syntax: {{trigger.field}} for trigger data, {{steps.step_0.field}} for previous step output. Return ONLY valid JSON.` }),
  });
  const data = await resp.json().catch(() => ({ error: 'AI generation failed' }));
  return c.json(data);
});

// ── AI: Suggest optimization ──
app.post('/ai/optimize', async (c) => {
  const b = await c.req.json() as { workflow_id: string };
  const wf = await c.env.DB.prepare('SELECT * FROM workflows WHERE id=?').bind(b.workflow_id).first<any>();
  if (!wf) return c.json({ error: 'Workflow not found' }, 404);
  const runs = await c.env.DB.prepare('SELECT status, duration_ms, error_message, steps_executed, steps_total FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC LIMIT 20').bind(b.workflow_id).all();
  const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine_id: 'GEN-01', query: `Analyze this workflow and suggest optimizations. Workflow: ${wf.name}. Steps: ${wf.steps_json}. Recent runs (last 20): ${JSON.stringify(runs.results)}. Suggest: 1) Performance improvements, 2) Error handling, 3) Step consolidation, 4) Reliability improvements.` }),
  });
  const data = await resp.json().catch(() => ({ error: 'AI optimization failed' }));
  return c.json(data);
});

// ── Scheduled handler ──
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Process scheduled workflows
    const due = await env.DB.prepare('SELECT sr.*, w.steps_json, w.error_handling, w.max_retries, w.tenant_id as wf_tenant FROM scheduled_runs sr JOIN workflows w ON sr.workflow_id=w.id WHERE sr.is_active=1 AND sr.next_run_at <= datetime(\'now\') AND w.status=\'active\' LIMIT 10').all();

    for (const sched of due.results as any[]) {
      const runId = uid();
      const steps = JSON.parse(sched.steps_json || '[]');
      await env.DB.prepare('INSERT INTO workflow_runs (id,workflow_id,tenant_id,status,trigger_data,steps_total) VALUES (?,?,?,\'running\',?,?)')
        .bind(runId, sched.workflow_id, sched.wf_tenant, '{"trigger":"scheduled"}', steps.length).run();

      await executeWorkflow(env, { id: sched.workflow_id, tenant_id: sched.wf_tenant, steps_json: sched.steps_json, error_handling: sched.error_handling, max_retries: sched.max_retries }, runId, steps, { trigger: 'scheduled' });

      // Advance next_run_at by 1 hour (simplified — production would parse cron)
      await env.DB.prepare('UPDATE scheduled_runs SET last_run_at=datetime(\'now\'), next_run_at=datetime(\'now\',\'+1 hour\') WHERE id=?').bind(sched.id).run();
    }

    // Cleanup old runs (>30 days)
    await env.DB.prepare('DELETE FROM workflow_runs WHERE started_at < datetime(\'now\',\'-30 days\')').run();
    await env.DB.prepare('DELETE FROM step_logs WHERE started_at < datetime(\'now\',\'-30 days\')').run();
    await env.DB.prepare('DELETE FROM activity_log WHERE created_at < datetime(\'now\',\'-90 days\')').run();
  },
};
