CREATE TABLE "plugin_permission_grant_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "scope_kind" TEXT NOT NULL,
    "scope_project_id" TEXT,
    "scope_workspace_id" TEXT,
    "requester_json" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "grant_id" TEXT,
    "created_by_user_id" TEXT,
    "decided_by_user_id" TEXT,
    "decided_at" BIGINT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "plugin_permission_grant_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "plugin_permission_grants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "scope_kind" TEXT NOT NULL,
    "scope_project_id" TEXT,
    "scope_workspace_id" TEXT,
    "status" TEXT NOT NULL,
    "request_id" TEXT,
    "granted_by_user_id" TEXT NOT NULL,
    "granted_at" BIGINT NOT NULL,
    "revoked_by_user_id" TEXT,
    "revoked_at" BIGINT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "plugin_permission_grants_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "plugin_permission_grant_events" (
    "event_id" TEXT NOT NULL PRIMARY KEY,
    "account_id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "scope_kind" TEXT NOT NULL,
    "scope_project_id" TEXT,
    "scope_workspace_id" TEXT,
    "event_kind" TEXT NOT NULL,
    "actor_json" TEXT NOT NULL,
    "request_id" TEXT,
    "grant_id" TEXT,
    "previous_state_json" TEXT,
    "next_state_json" TEXT,
    "reason" TEXT,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "plugin_permission_grant_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "plugin_permission_grants_scope_idx"
ON "plugin_permission_grants"("account_id", "plugin_id", "capability", "scope_kind", "scope_project_id", "scope_workspace_id", "status", "updated_at");

CREATE INDEX "plugin_permission_grants_request_idx"
ON "plugin_permission_grants"("account_id", "request_id");

CREATE INDEX "plugin_permission_requests_scope_idx"
ON "plugin_permission_grant_requests"("account_id", "plugin_id", "capability", "scope_kind", "scope_project_id", "scope_workspace_id", "status", "updated_at");

CREATE INDEX "plugin_permission_requests_grant_idx"
ON "plugin_permission_grant_requests"("account_id", "grant_id");

CREATE INDEX "plugin_permission_events_kind_idx"
ON "plugin_permission_grant_events"("account_id", "plugin_id", "capability", "event_kind", "created_at");

CREATE INDEX "plugin_permission_events_request_idx"
ON "plugin_permission_grant_events"("account_id", "request_id");

CREATE INDEX "plugin_permission_events_grant_idx"
ON "plugin_permission_grant_events"("account_id", "grant_id");
