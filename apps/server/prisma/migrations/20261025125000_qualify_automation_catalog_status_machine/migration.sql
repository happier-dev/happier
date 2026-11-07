-- Materialization ids are Machine-local; retain each existing row's reporter.
ALTER TABLE "AutomationEventSourceCatalogStatus"
    DROP CONSTRAINT "AutomationEventSourceCatalogStatus_pkey",
    ADD CONSTRAINT "AutomationEventSourceCatalogStatus_pkey"
        PRIMARY KEY ("accountId", "eventPluginId", "reporterMachineId", "reporterMaterializationId", "scopeKey");
