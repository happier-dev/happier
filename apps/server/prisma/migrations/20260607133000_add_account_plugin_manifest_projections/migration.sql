CREATE TABLE "account_plugin_manifest_projections" (
    "account_id" TEXT NOT NULL,
    "machine_id" TEXT NOT NULL,
    "plugin_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "plugin_version" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "manifest_digest" TEXT NOT NULL,
    "source_json" TEXT,
    "required_permissions_json" TEXT NOT NULL,
    "optional_permissions_json" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "disabled_at" BIGINT,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "account_plugin_manifest_projections_pkey" PRIMARY KEY ("account_id", "machine_id", "plugin_id")
);

CREATE INDEX "account_plugin_manifest_projection_plugin_lookup_idx"
ON "account_plugin_manifest_projections"("account_id", "plugin_id", "enabled");

CREATE INDEX "account_plugin_manifest_projection_machine_lookup_idx"
ON "account_plugin_manifest_projections"("account_id", "machine_id", "plugin_id", "enabled");

CREATE INDEX "account_plugin_manifest_projection_list_idx"
ON "account_plugin_manifest_projections"("account_id", "enabled", "updated_at");

ALTER TABLE "account_plugin_manifest_projections" ADD CONSTRAINT "account_plugin_manifest_projections_account_id_fkey"
FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_plugin_manifest_projections" ADD CONSTRAINT "account_plugin_manifest_projections_machine_fkey"
FOREIGN KEY ("account_id", "machine_id") REFERENCES "Machine"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
