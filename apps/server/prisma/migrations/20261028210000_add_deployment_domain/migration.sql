-- Domain cleanup retains relational custody; route content remains private.
CREATE TABLE "DeploymentDomain" (
    "id" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "targetLinkId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "state" TEXT NOT NULL,
    "capturedPlacements" JSONB,
    "contentArtifactId" TEXT NOT NULL,
    "contentHeaderVersion" INTEGER NOT NULL,
    "contentBodyVersion" INTEGER NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "DeploymentDomain_values_check" CHECK ("revision" >= 1 AND "contentHeaderVersion" >= 1 AND "contentBodyVersion" >= 1 AND "state" IN ('pending', 'applying', 'active', 'warning', 'failed', 'removing')),
    CONSTRAINT "DeploymentDomain_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DeploymentDomain_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentDomain_targetLinkId_fkey" FOREIGN KEY ("targetLinkId") REFERENCES "DeploymentTargetLink" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentDomain_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentDomain_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DeploymentDomain_environmentId_deletedAt_id_idx" ON "DeploymentDomain"("environmentId", "deletedAt", "id");
CREATE INDEX "DeploymentDomain_environmentId_state_id_idx" ON "DeploymentDomain"("environmentId", "state", "id");
