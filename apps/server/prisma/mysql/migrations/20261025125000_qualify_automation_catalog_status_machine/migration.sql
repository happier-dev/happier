-- Materialization ids are Machine-local; retain each existing row's reporter.
ALTER TABLE `AutomationEventSourceCatalogStatus`
    DROP PRIMARY KEY,
    ADD PRIMARY KEY (`accountId`, `eventPluginId`, `reporterMachineId`, `reporterMaterializationId`, `scopeKey`);
