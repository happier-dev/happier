-- SQLite requires a table rebuild to relax hostTargetId and replace its CHECK.
-- The canonical migration runner honors FK-OFF outside its transaction and
-- restores FK enforcement after the rebuild preserves both reference cycles.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_DeploymentTargetLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "role" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "hostTargetId" TEXT,
    "pluginId" TEXT,
    "contributionLocalId" TEXT,
    "targetKind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "machineId" TEXT,
    "installationId" TEXT,
    "activeDeploymentId" TEXT,
    "detachedAt" DATETIME,
    "contentArtifactId" TEXT NOT NULL,
    "contentHeaderVersion" INTEGER NOT NULL,
    "contentBodyVersion" INTEGER NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "DeploymentTargetLink_values_check" CHECK (
        "revision" >= 1 AND "contentHeaderVersion" >= 1 AND "contentBodyVersion" >= 1
        AND "state" IN ('none', 'configured', 'provisioned', 'deployed')
        AND (
            ("sourceKind" = 'host' AND "role" = 'runtime' AND "targetKind" = 'ownServer'
                AND "hostTargetId" IS NOT NULL
                AND "pluginId" IS NULL AND "contributionLocalId" IS NULL)
            OR ("sourceKind" = 'plugin' AND "role" IN ('runtime', 'data')
                AND "hostTargetId" IS NULL AND LENGTH(TRIM("targetKind")) > 0
                AND "pluginId" IS NOT NULL AND LENGTH(TRIM("pluginId")) > 0
                AND "contributionLocalId" IS NOT NULL AND LENGTH(TRIM("contributionLocalId")) > 0)
        )
    ),
    CONSTRAINT "DeploymentTargetLink_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTargetLink_activeDeploymentId_fkey" FOREIGN KEY ("activeDeploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTargetLink_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTargetLink_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentTargetLink_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DeploymentTargetLink" ("id","environmentId","revision","role","sourceKind","hostTargetId","targetKind","state","activeDeploymentId","detachedAt","contentArtifactId","contentHeaderVersion","contentBodyVersion","createdByAccountId","createdAt","updatedAt","deletedAt")
    SELECT "id","environmentId","revision","role","sourceKind","hostTargetId","targetKind","state","activeDeploymentId","detachedAt","contentArtifactId","contentHeaderVersion","contentBodyVersion","createdByAccountId","createdAt","updatedAt","deletedAt" FROM "DeploymentTargetLink";
DROP TABLE "DeploymentTargetLink";
ALTER TABLE "new_DeploymentTargetLink" RENAME TO "DeploymentTargetLink";
CREATE INDEX "DeploymentTargetLink_environmentId_role_deletedAt_id_idx" ON "DeploymentTargetLink"("environmentId", "role", "deletedAt", "id");
CREATE INDEX "DeploymentTargetLink_machineId_deletedAt_id_idx" ON "DeploymentTargetLink"("machineId", "deletedAt", "id");
CREATE INDEX "DeploymentTargetLink_pluginId_contributionLocalId_idx" ON "DeploymentTargetLink"("pluginId", "contributionLocalId");

PRAGMA foreign_keys=ON;
