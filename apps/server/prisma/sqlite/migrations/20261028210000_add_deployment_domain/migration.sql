-- Domain cleanup retains relational custody; route content remains private.
CREATE TABLE "DeploymentDomain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "targetLinkId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL,
    "capturedPlacements" JSONB,
    "contentArtifactId" TEXT NOT NULL,
    "contentHeaderVersion" INTEGER NOT NULL,
    "contentBodyVersion" INTEGER NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "observedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "DeploymentDomain_values_check" CHECK ("revision" >= 1 AND "contentHeaderVersion" >= 1 AND "contentBodyVersion" >= 1 AND "state" IN ('pending', 'applying', 'active', 'warning', 'failed', 'removing')),
    CONSTRAINT "DeploymentDomain_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentDomain_targetLinkId_fkey" FOREIGN KEY ("targetLinkId") REFERENCES "DeploymentTargetLink" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentDomain_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentDomain_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DeploymentDomain_environmentId_deletedAt_id_idx" ON "DeploymentDomain"("environmentId", "deletedAt", "id");
CREATE INDEX "DeploymentDomain_environmentId_state_id_idx" ON "DeploymentDomain"("environmentId", "state", "id");
