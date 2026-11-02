CREATE TABLE "MachineSecretGrant" (
    "subjectKey" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "environmentId" TEXT,
    "resourceId" TEXT,
    "resourceRevision" INTEGER,
    "phase" TEXT,
    "name" TEXT,
    "providerPluginId" TEXT,
    "providerLocalId" TEXT,
    "connectorId" TEXT,
    "contentEnvelope" TEXT NOT NULL,
    CONSTRAINT "MachineSecretGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineSecretGrant_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineSecretGrant_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "SavedSecretResource"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "MSG_environment_installation_idx" ON "MachineSecretGrant"("environmentId", "machineId", "installationId");
CREATE INDEX "MSG_installation_idx" ON "MachineSecretGrant"("machineId", "installationId");
CREATE INDEX "MSG_resource_idx" ON "MachineSecretGrant"("resourceId");
