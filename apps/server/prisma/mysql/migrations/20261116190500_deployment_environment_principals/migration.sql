-- Deployers and database editors share one Environment principal store (PrincipalRefV1 kinds).
-- 0.3-unreleased rows are rewritten in place: 'teamGroup' becomes 'group' with its owning Team.
ALTER TABLE `DeploymentEnvironmentDeployer` DROP CHECK `DeploymentEnvironmentDeployer_values_check`;
ALTER TABLE `DeploymentEnvironmentDeployer` ADD COLUMN `purpose` VARCHAR(191) NOT NULL DEFAULT 'deploy',
    ADD COLUMN `principalTeamId` VARCHAR(191) NULL;
ALTER TABLE `DeploymentEnvironmentDeployer` ALTER COLUMN `purpose` DROP DEFAULT;
UPDATE `DeploymentEnvironmentDeployer` AS d JOIN `TeamGroup` AS g ON g.`id` = d.`principalId`
    SET d.`principalKind` = 'group', d.`principalTeamId` = g.`teamId` WHERE d.`principalKind` = 'teamGroup';
DELETE FROM `DeploymentEnvironmentDeployer` WHERE `principalKind` = 'teamGroup';
ALTER TABLE `DeploymentEnvironmentDeployer` DROP PRIMARY KEY,
    ADD PRIMARY KEY (`environmentId`, `purpose`, `principalKind`, `principalId`);
ALTER TABLE `DeploymentEnvironmentDeployer` ADD CONSTRAINT `DeploymentEnvironmentDeployer_values_check` CHECK (
    `purpose` IN ('deploy', 'dataEdit') AND `principalKind` IN ('account', 'team', 'group')
    AND ((`principalKind` = 'group') = (`principalTeamId` IS NOT NULL)));

-- Environment database access (server-readable decision facts, ids only; docs/encryption.md).
ALTER TABLE `DeploymentEnvironment` ADD COLUMN `dataEditorMode` VARCHAR(191) NOT NULL DEFAULT 'off',
    ADD COLUMN `dataAgentAccess` VARCHAR(191) NOT NULL DEFAULT 'read',
    ADD CONSTRAINT `DeploymentEnvironment_dataEditorMode_check` CHECK (`dataEditorMode` IN ('off', 'managers', 'members', 'chosen')),
    ADD CONSTRAINT `DeploymentEnvironment_dataAgentAccess_check` CHECK (`dataAgentAccess` IN ('none', 'read'));
