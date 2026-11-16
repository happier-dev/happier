-- Deployers and database editors share one Environment principal store (PrincipalRefV1 kinds).
-- 0.3-unreleased rows are rewritten in place: 'teamGroup' becomes 'group' with its owning Team.
ALTER TABLE "DeploymentEnvironmentDeployer" DROP CONSTRAINT "DeploymentEnvironmentDeployer_values_check";
ALTER TABLE "DeploymentEnvironmentDeployer" DROP CONSTRAINT "DeploymentEnvironmentDeployer_pkey";
ALTER TABLE "DeploymentEnvironmentDeployer" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'deploy';
ALTER TABLE "DeploymentEnvironmentDeployer" ALTER COLUMN "purpose" DROP DEFAULT;
ALTER TABLE "DeploymentEnvironmentDeployer" ADD COLUMN "principalTeamId" TEXT;
UPDATE "DeploymentEnvironmentDeployer" AS d SET "principalKind" = 'group', "principalTeamId" = g."teamId"
    FROM "TeamGroup" AS g WHERE d."principalKind" = 'teamGroup' AND g."id" = d."principalId";
DELETE FROM "DeploymentEnvironmentDeployer" WHERE "principalKind" = 'teamGroup';
ALTER TABLE "DeploymentEnvironmentDeployer" ADD CONSTRAINT "DeploymentEnvironmentDeployer_pkey"
    PRIMARY KEY ("environmentId", "purpose", "principalKind", "principalId");
ALTER TABLE "DeploymentEnvironmentDeployer" ADD CONSTRAINT "DeploymentEnvironmentDeployer_values_check" CHECK (
    "purpose" IN ('deploy', 'dataEdit') AND "principalKind" IN ('account', 'team', 'group')
    AND (("principalKind" = 'group') = ("principalTeamId" IS NOT NULL)));

-- Environment database access (server-readable decision facts, ids only; docs/encryption.md).
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "dataEditorMode" TEXT NOT NULL DEFAULT 'off'
    CONSTRAINT "DeploymentEnvironment_dataEditorMode_check" CHECK ("dataEditorMode" IN ('off', 'managers', 'members', 'chosen'));
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "dataAgentAccess" TEXT NOT NULL DEFAULT 'read'
    CONSTRAINT "DeploymentEnvironment_dataAgentAccess_check" CHECK ("dataAgentAccess" IN ('none', 'read'));
