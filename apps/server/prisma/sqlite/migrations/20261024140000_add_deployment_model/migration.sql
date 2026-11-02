-- CreateTable
CREATE TABLE "DeploymentEnvironment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectSourceId" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "protection" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "deployerMode" TEXT NOT NULL,
    "controllerMachineId" TEXT NOT NULL,
    "buildMachineId" TEXT,
    "runtimeTargetLinkId" TEXT,
    "contentArtifactId" TEXT NOT NULL,
    "contentHeaderVersion" INTEGER NOT NULL,
    "contentBodyVersion" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "DeploymentEnvironment_values_check" CHECK ("revision" >= 1 AND "contentHeaderVersion" >= 1 AND "contentBodyVersion" >= 1 AND "protection" IN ('production', 'nonProduction') AND "purpose" IN ('standard', 'preview') AND "deployerMode" IN ('managers', 'members', 'chosen')),
    CONSTRAINT "DeploymentEnvironment_projectSourceId_fkey" FOREIGN KEY ("projectSourceId") REFERENCES "ProjectSource" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentEnvironment_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentEnvironment_controllerMachineId_fkey" FOREIGN KEY ("controllerMachineId") REFERENCES "Machine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentEnvironment_buildMachineId_fkey" FOREIGN KEY ("buildMachineId") REFERENCES "Machine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentEnvironment_runtimeTargetLinkId_fkey" FOREIGN KEY ("runtimeTargetLinkId") REFERENCES "DeploymentTargetLink" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentEnvironment_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeploymentTargetLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "role" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "hostTargetId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "activeDeploymentId" TEXT,
    "contentArtifactId" TEXT NOT NULL,
    "contentHeaderVersion" INTEGER NOT NULL,
    "contentBodyVersion" INTEGER NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "DeploymentTargetLink_values_check" CHECK ("revision" >= 1 AND "contentHeaderVersion" >= 1 AND "contentBodyVersion" >= 1 AND "role" = 'runtime' AND "sourceKind" = 'host' AND "targetKind" = 'ownServer' AND "state" IN ('none', 'configured', 'provisioned', 'deployed')),
    CONSTRAINT "DeploymentTargetLink_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTargetLink_activeDeploymentId_fkey" FOREIGN KEY ("activeDeploymentId") REFERENCES "Deployment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTargetLink_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTargetLink_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeploymentTargetLinkMachine" (
    "targetLinkId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "installationId" TEXT NOT NULL,
    "state" TEXT NOT NULL,

    PRIMARY KEY ("targetLinkId", "machineId"),
    CONSTRAINT "DeploymentTargetLinkMachine_values_check" CHECK ("position" >= 0 AND "state" IN ('joining', 'active')),
    CONSTRAINT "DeploymentTargetLinkMachine_targetLinkId_fkey" FOREIGN KEY ("targetLinkId") REFERENCES "DeploymentTargetLink" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTargetLinkMachine_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "targetLinkId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "operation" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestedByAccountId" TEXT NOT NULL,
    "actionOperationId" TEXT NOT NULL,
    "predecessorDeploymentId" TEXT,
    "rollbackOfDeploymentId" TEXT,
    "approvalId" TEXT,
    "cancelRequestedAt" DATETIME,
    "contentArtifactId" TEXT NOT NULL,
    "contentHeaderVersion" INTEGER NOT NULL,
    "contentBodyVersion" INTEGER NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "settledAt" DATETIME,
    CONSTRAINT "Deployment_values_check" CHECK ("revision" >= 1 AND "contentHeaderVersion" >= 1 AND "contentBodyVersion" >= 1 AND "operation" IN ('deploy', 'rollback', 'promote', 'teardown') AND "state" IN ('queued', 'waitingApproval', 'running', 'running_unverified', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')),
    CONSTRAINT "Deployment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_targetLinkId_fkey" FOREIGN KEY ("targetLinkId") REFERENCES "DeploymentTargetLink" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_requestedByAccountId_fkey" FOREIGN KEY ("requestedByAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_predecessorDeploymentId_fkey" FOREIGN KEY ("predecessorDeploymentId") REFERENCES "Deployment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_rollbackOfDeploymentId_fkey" FOREIGN KEY ("rollbackOfDeploymentId") REFERENCES "Deployment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deployment_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentEnvironment_runtimeTargetLinkId_key" ON "DeploymentEnvironment"("runtimeTargetLinkId");

-- CreateIndex
CREATE INDEX "DeploymentEnvironment_projectSourceId_deletedAt_id_idx" ON "DeploymentEnvironment"("projectSourceId", "deletedAt", "id");

-- CreateIndex
CREATE INDEX "DeploymentEnvironment_controllerMachineId_deletedAt_id_idx" ON "DeploymentEnvironment"("controllerMachineId", "deletedAt", "id");

-- CreateIndex
CREATE INDEX "DeploymentEnvironment_buildMachineId_deletedAt_id_idx" ON "DeploymentEnvironment"("buildMachineId", "deletedAt", "id");

-- CreateIndex
CREATE INDEX "DeploymentTargetLink_environmentId_role_deletedAt_id_idx" ON "DeploymentTargetLink"("environmentId", "role", "deletedAt", "id");

-- CreateIndex
CREATE INDEX "DeploymentTargetLinkMachine_machineId_targetLinkId_idx" ON "DeploymentTargetLinkMachine"("machineId", "targetLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentTargetLinkMachine_targetLinkId_position_key" ON "DeploymentTargetLinkMachine"("targetLinkId", "position");

-- CreateIndex
CREATE INDEX "Deployment_environmentId_requestedAt_id_idx" ON "Deployment"("environmentId", "requestedAt", "id");

-- CreateIndex
CREATE INDEX "Deployment_environmentId_state_id_idx" ON "Deployment"("environmentId", "state", "id");

-- CreateIndex
CREATE INDEX "Deployment_actionOperationId_idx" ON "Deployment"("actionOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_environmentId_requestKey_key" ON "Deployment"("environmentId", "requestKey");

