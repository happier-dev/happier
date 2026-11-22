-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "targetLinkId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "operation" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestedByAccountId" TEXT,
    "actionOperationId" TEXT NOT NULL,
    "originRunId" TEXT,
    "acceptedRequestEnvelopeDigest" TEXT,
    "acceptedControllerMachineId" TEXT,
    "acceptedControllerInstallationId" TEXT,
    "acceptedBuildMachineId" TEXT,
    "acceptedBuildInstallationId" TEXT,
    "teardownProof" JSONB,
    "predecessorDeploymentId" TEXT,
    "restoreBackupId" TEXT,
    "rollbackOfDeploymentId" TEXT,
    "promotedFromDeploymentId" TEXT,
    "approvalId" TEXT,
    "cancelRequestedAt" DATETIME,
    "contentArtifactId" TEXT,
    "contentHeaderVersion" INTEGER NOT NULL,
    "contentBodyVersion" INTEGER NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "settledAt" DATETIME,
    CONSTRAINT "Deployment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_targetLinkId_fkey" FOREIGN KEY ("targetLinkId") REFERENCES "DeploymentTargetLink" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_requestedByAccountId_fkey" FOREIGN KEY ("requestedByAccountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Deployment_predecessorDeploymentId_fkey" FOREIGN KEY ("predecessorDeploymentId") REFERENCES "Deployment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_rollbackOfDeploymentId_fkey" FOREIGN KEY ("rollbackOfDeploymentId") REFERENCES "Deployment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_promotedFromDeploymentId_fkey" FOREIGN KEY ("promotedFromDeploymentId") REFERENCES "Deployment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Deployment" ("acceptedBuildInstallationId", "acceptedBuildMachineId", "acceptedControllerInstallationId", "acceptedControllerMachineId", "acceptedRequestEnvelopeDigest", "actionOperationId", "approvalId", "cancelRequestedAt", "contentArtifactId", "contentBodyVersion", "contentHeaderVersion", "environmentId", "id", "operation", "originRunId", "predecessorDeploymentId", "promotedFromDeploymentId", "requestKey", "requestedAt", "requestedByAccountId", "restoreBackupId", "revision", "rollbackOfDeploymentId", "settledAt", "startedAt", "state", "targetLinkId", "teardownProof") SELECT "acceptedBuildInstallationId", "acceptedBuildMachineId", "acceptedControllerInstallationId", "acceptedControllerMachineId", "acceptedRequestEnvelopeDigest", "actionOperationId", "approvalId", "cancelRequestedAt", "contentArtifactId", "contentBodyVersion", "contentHeaderVersion", "environmentId", "id", "operation", "originRunId", "predecessorDeploymentId", "promotedFromDeploymentId", "requestKey", "requestedAt", "requestedByAccountId", "restoreBackupId", "revision", "rollbackOfDeploymentId", "settledAt", "startedAt", "state", "targetLinkId", "teardownProof" FROM "Deployment";
DROP TABLE "Deployment";
ALTER TABLE "new_Deployment" RENAME TO "Deployment";
CREATE INDEX "Deployment_environmentId_requestedAt_id_idx" ON "Deployment"("environmentId", "requestedAt", "id");
CREATE INDEX "Deployment_environmentId_state_id_idx" ON "Deployment"("environmentId", "state", "id");
CREATE INDEX "Deployment_requestedByAccountId_state_idx" ON "Deployment"("requestedByAccountId", "state");
CREATE INDEX "Deployment_actionOperationId_idx" ON "Deployment"("actionOperationId");
CREATE INDEX "Deployment_acceptedControllerMachineId_state_id_idx" ON "Deployment"("acceptedControllerMachineId", "state", "id");
CREATE INDEX "Deployment_acceptedBuildMachineId_state_id_idx" ON "Deployment"("acceptedBuildMachineId", "state", "id");
CREATE INDEX "Deployment_contentArtifactId_idx" ON "Deployment"("contentArtifactId");
CREATE UNIQUE INDEX "Deployment_environmentId_requestKey_key" ON "Deployment"("environmentId", "requestKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
