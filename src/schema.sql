-- Echo Workflow Automation v1.0.0 — Zapier alternative for Echo ecosystem
-- Trigger-action workflows connecting all Echo SaaS products

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT DEFAULT 'starter',
  max_workflows INTEGER DEFAULT 10,
  max_runs_per_day INTEGER DEFAULT 100,
  webhook_secret TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'draft', -- draft, active, paused, error
  trigger_type TEXT NOT NULL, -- webhook, schedule, event, manual
  trigger_config TEXT DEFAULT '{}', -- JSON: cron, webhook_path, event_name, etc.
  steps_json TEXT DEFAULT '[]', -- JSON array of step definitions
  error_handling TEXT DEFAULT 'stop', -- stop, skip, retry
  max_retries INTEGER DEFAULT 3,
  retry_delay_sec INTEGER DEFAULT 60,
  last_run_at TEXT,
  run_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_duration_ms INTEGER DEFAULT 0,
  tags TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_trigger ON workflows(trigger_type);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  status TEXT DEFAULT 'running', -- running, completed, failed, cancelled, timeout
  trigger_data TEXT DEFAULT '{}', -- JSON: incoming webhook data, schedule info, etc.
  steps_executed INTEGER DEFAULT 0,
  steps_total INTEGER DEFAULT 0,
  current_step INTEGER DEFAULT 0,
  error_message TEXT,
  error_step INTEGER,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  duration_ms INTEGER,
  output_data TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_runs_tenant ON workflow_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON workflow_runs(started_at);

CREATE TABLE IF NOT EXISTS step_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  step_type TEXT NOT NULL, -- http, transform, condition, delay, echo_service, ai
  step_name TEXT,
  status TEXT DEFAULT 'pending', -- pending, running, completed, failed, skipped
  input_data TEXT DEFAULT '{}',
  output_data TEXT DEFAULT '{}',
  error_message TEXT,
  duration_ms INTEGER,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_steplogs_run ON step_logs(run_id);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  trigger_type TEXT NOT NULL,
  trigger_config TEXT DEFAULT '{}',
  steps_json TEXT DEFAULT '[]',
  use_count INTEGER DEFAULT 0,
  is_official INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  service_name TEXT NOT NULL, -- echo-crm, echo-helpdesk, echo-invoice, slack, etc.
  display_name TEXT,
  auth_type TEXT DEFAULT 'api_key', -- api_key, oauth, bearer, none
  credentials_json TEXT DEFAULT '{}', -- encrypted/redacted
  status TEXT DEFAULT 'active', -- active, revoked, error
  last_used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connections_tenant ON connections(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_unique ON connections(tenant_id, service_name);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  path TEXT NOT NULL, -- unique webhook path
  method TEXT DEFAULT 'POST',
  is_active INTEGER DEFAULT 1,
  last_triggered_at TEXT,
  trigger_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_path ON webhooks(path);

CREATE TABLE IF NOT EXISTS scheduled_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_next ON scheduled_runs(next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_active ON scheduled_runs(is_active);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
