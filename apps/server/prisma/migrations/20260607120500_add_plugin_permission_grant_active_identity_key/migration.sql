ALTER TABLE "plugin_permission_grants"
ADD COLUMN "active_identity_key" TEXT;

UPDATE "plugin_permission_grants"
SET "active_identity_key" =
    "plugin_id" || CHR(31) ||
    "capability" || CHR(31) ||
    "scope_kind" || CHR(31) ||
    COALESCE("scope_project_id", '') || CHR(31) ||
    COALESCE("scope_workspace_id", '')
WHERE "status" = 'active';

CREATE UNIQUE INDEX "plugin_permission_grants_active_identity_key"
ON "plugin_permission_grants"("account_id", "active_identity_key");
