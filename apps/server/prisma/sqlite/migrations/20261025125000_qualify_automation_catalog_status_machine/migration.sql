-- SQLite requires a table rebuild to widen the primary key. Copy all facts as-is.
CREATE TABLE "new_AutomationEventSourceCatalogStatus" (
    "accountId" TEXT NOT NULL,
    "eventPluginId" TEXT NOT NULL,
    "reporterMachineId" TEXT NOT NULL,
    "reporterMachineInstallationId" TEXT NOT NULL,
    "reporterMaterializationId" TEXT NOT NULL,
    "reporterSourceCustody" JSONB NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "observedRevision" BIGINT NOT NULL,
    "adoptedRevision" BIGINT,
    "state" TEXT NOT NULL,
    "scanStartedAt" DATETIME,
    "nextRetryAt" DATETIME,
    "reportedAt" DATETIME NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("accountId", "eventPluginId", "reporterMachineId", "reporterMaterializationId", "scopeKey"),
    CONSTRAINT "AutomationEventSourceCatalogStatus_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_AutomationEventSourceCatalogStatus" (
    "accountId", "eventPluginId", "reporterMachineId", "reporterMachineInstallationId",
    "reporterMaterializationId", "reporterSourceCustody", "scopeKey", "observedRevision",
    "adoptedRevision", "state", "scanStartedAt", "nextRetryAt", "reportedAt", "revision"
)
SELECT
    "accountId", "eventPluginId", "reporterMachineId", "reporterMachineInstallationId",
    "reporterMaterializationId", "reporterSourceCustody", "scopeKey", "observedRevision",
    "adoptedRevision", "state", "scanStartedAt", "nextRetryAt", "reportedAt", "revision"
FROM "AutomationEventSourceCatalogStatus";

DROP TABLE "AutomationEventSourceCatalogStatus";
ALTER TABLE "new_AutomationEventSourceCatalogStatus" RENAME TO "AutomationEventSourceCatalogStatus";
CREATE INDEX "AutomationEventSourceCatalogStatus_state_reportedAt_idx"
    ON "AutomationEventSourceCatalogStatus"("state", "reportedAt");
