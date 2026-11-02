-- Chosen deployers retain references only; current Source/Team admission supplies authority.
CREATE TABLE `DeploymentEnvironmentDeployer` (
    `environmentId` VARCHAR(191) NOT NULL,
    `principalKind` VARCHAR(191) NOT NULL,
    `principalId` VARCHAR(191) NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `DeploymentEnvironmentDeployer_values_check` CHECK (`principalKind` IN ('account', 'teamGroup')),
    PRIMARY KEY (`environmentId`, `principalKind`, `principalId`),
    CONSTRAINT `DeploymentEnvironmentDeployer_environmentId_fkey` FOREIGN KEY (`environmentId`) REFERENCES `DeploymentEnvironment` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `DeploymentEnvironmentDeployer_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
