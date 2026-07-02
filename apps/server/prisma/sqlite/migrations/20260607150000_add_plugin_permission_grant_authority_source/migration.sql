ALTER TABLE "plugin_permission_grant_requests"
ADD COLUMN "authority_kind" TEXT NOT NULL DEFAULT 'bundled';
ALTER TABLE "plugin_permission_grant_requests"
ADD COLUMN "authority_machine_id" TEXT;
ALTER TABLE "plugin_permission_grant_requests"
ADD COLUMN "authority_installation_id" TEXT;

ALTER TABLE "plugin_permission_grants"
ADD COLUMN "authority_kind" TEXT NOT NULL DEFAULT 'bundled';
ALTER TABLE "plugin_permission_grants"
ADD COLUMN "authority_machine_id" TEXT;
ALTER TABLE "plugin_permission_grants"
ADD COLUMN "authority_installation_id" TEXT;

ALTER TABLE "plugin_permission_grant_events"
ADD COLUMN "authority_kind" TEXT NOT NULL DEFAULT 'bundled';
ALTER TABLE "plugin_permission_grant_events"
ADD COLUMN "authority_machine_id" TEXT;
ALTER TABLE "plugin_permission_grant_events"
ADD COLUMN "authority_installation_id" TEXT;

DROP INDEX "plugin_permission_grants_scope_idx";
CREATE INDEX "plugin_permission_grants_scope_idx"
ON "plugin_permission_grants"(
    "account_id",
    "plugin_id",
    "capability",
    "scope_kind",
    "scope_project_id",
    "scope_workspace_id",
    "authority_kind",
    "authority_machine_id",
    "authority_installation_id",
    "status",
    "updated_at"
);

DROP INDEX "plugin_permission_requests_scope_idx";
CREATE INDEX "plugin_permission_requests_scope_idx"
ON "plugin_permission_grant_requests"(
    "account_id",
    "plugin_id",
    "capability",
    "scope_kind",
    "scope_project_id",
    "scope_workspace_id",
    "authority_kind",
    "authority_machine_id",
    "authority_installation_id",
    "status",
    "updated_at"
);

UPDATE "plugin_permission_grants"
SET "active_identity_key" =
    "plugin_id" || CHAR(31) ||
    "capability" || CHAR(31) ||
    "scope_kind" || CHAR(31) ||
    COALESCE("scope_project_id", '') || CHAR(31) ||
    COALESCE("scope_workspace_id", '') || CHAR(31) ||
    "authority_kind" || CHAR(31) ||
    COALESCE("authority_machine_id", '') || CHAR(31) ||
    COALESCE("authority_installation_id", '')
WHERE "status" = 'active';
