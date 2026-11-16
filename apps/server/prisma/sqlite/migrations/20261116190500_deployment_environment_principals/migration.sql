-- Deployers and database editors share one Environment principal store (PrincipalRefV1 kinds).
-- 0.3-unreleased rows are rewritten in place: 'teamGroup' becomes 'group' with its owning Team.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DeploymentEnvironmentDeployer" (
    "environmentId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "principalKind" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "principalTeamId" TEXT,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeploymentEnvironmentDeployer_values_check" CHECK (
        "purpose" IN ('deploy', 'dataEdit') AND "principalKind" IN ('account', 'team', 'group')
        AND (("principalKind" = 'group') = ("principalTeamId" IS NOT NULL))),
    PRIMARY KEY ("environmentId", "purpose", "principalKind", "principalId"),
    CONSTRAINT "DeploymentEnvironmentDeployer_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "DeploymentEnvironment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeploymentEnvironmentDeployer_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DeploymentEnvironmentDeployer" ("environmentId", "purpose", "principalKind", "principalId", "principalTeamId", "createdByAccountId", "createdAt")
SELECT d."environmentId", 'deploy', 'account', d."principalId", NULL, d."createdByAccountId", d."createdAt"
FROM "DeploymentEnvironmentDeployer" d WHERE d."principalKind" = 'account'
UNION ALL
SELECT d."environmentId", 'deploy', 'group', d."principalId", g."teamId", d."createdByAccountId", d."createdAt"
FROM "DeploymentEnvironmentDeployer" d JOIN "TeamGroup" g ON g."id" = d."principalId" WHERE d."principalKind" = 'teamGroup';
DROP TABLE "DeploymentEnvironmentDeployer";
ALTER TABLE "new_DeploymentEnvironmentDeployer" RENAME TO "DeploymentEnvironmentDeployer";
-- Environment database access (server-readable decision facts, ids only; docs/encryption.md).
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "dataEditorMode" TEXT NOT NULL DEFAULT 'off'
    CONSTRAINT "DeploymentEnvironment_dataEditorMode_check" CHECK ("dataEditorMode" IN ('off', 'managers', 'members', 'chosen'));
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "dataAgentAccess" TEXT NOT NULL DEFAULT 'read'
    CONSTRAINT "DeploymentEnvironment_dataAgentAccess_check" CHECK ("dataAgentAccess" IN ('none', 'read'));
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
