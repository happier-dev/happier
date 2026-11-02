-- CreateTable
CREATE TABLE `DeploymentEnvironment` (
    `id` VARCHAR(191) NOT NULL,
    `projectSourceId` VARCHAR(191) NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `protection` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(191) NOT NULL,
    `deployerMode` VARCHAR(191) NOT NULL,
    `controllerMachineId` VARCHAR(191) NOT NULL,
    `buildMachineId` VARCHAR(191) NULL,
    `runtimeTargetLinkId` VARCHAR(191) NULL,
    `contentArtifactId` VARCHAR(191) NOT NULL,
    `contentHeaderVersion` INTEGER NOT NULL,
    `contentBodyVersion` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    CONSTRAINT `DeploymentEnvironment_values_check` CHECK (`revision` >= 1 AND `contentHeaderVersion` >= 1 AND `contentBodyVersion` >= 1 AND `protection` IN ('production', 'nonProduction') AND `purpose` IN ('standard', 'preview') AND `deployerMode` IN ('managers', 'members', 'chosen')),
    UNIQUE INDEX `DeploymentEnvironment_runtimeTargetLinkId_key`(`runtimeTargetLinkId`),
    INDEX `DeploymentEnvironment_projectSourceId_deletedAt_id_idx`(`projectSourceId`, `deletedAt`, `id`),
    INDEX `DeploymentEnvironment_controllerMachineId_deletedAt_id_idx`(`controllerMachineId`, `deletedAt`, `id`),
    INDEX `DeploymentEnvironment_buildMachineId_deletedAt_id_idx`(`buildMachineId`, `deletedAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeploymentTargetLink` (
    `id` VARCHAR(191) NOT NULL,
    `environmentId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `role` VARCHAR(191) NOT NULL,
    `sourceKind` VARCHAR(191) NOT NULL,
    `hostTargetId` VARCHAR(191) NOT NULL,
    `targetKind` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `activeDeploymentId` VARCHAR(191) NULL,
    `contentArtifactId` VARCHAR(191) NOT NULL,
    `contentHeaderVersion` INTEGER NOT NULL,
    `contentBodyVersion` INTEGER NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    CONSTRAINT `DeploymentTargetLink_values_check` CHECK (`revision` >= 1 AND `contentHeaderVersion` >= 1 AND `contentBodyVersion` >= 1 AND `role` = 'runtime' AND `sourceKind` = 'host' AND `targetKind` = 'ownServer' AND `state` IN ('none', 'configured', 'provisioned', 'deployed')),
    INDEX `DeploymentTargetLink_environmentId_role_deletedAt_id_idx`(`environmentId`, `role`, `deletedAt`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeploymentTargetLinkMachine` (
    `targetLinkId` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL,
    `installationId` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,

    CONSTRAINT `DeploymentTargetLinkMachine_values_check` CHECK (`position` >= 0 AND `state` IN ('joining', 'active')),
    INDEX `DeploymentTargetLinkMachine_machineId_targetLinkId_idx`(`machineId`, `targetLinkId`),
    UNIQUE INDEX `DeploymentTargetLinkMachine_targetLinkId_position_key`(`targetLinkId`, `position`),
    PRIMARY KEY (`targetLinkId`, `machineId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Deployment` (
    `id` VARCHAR(191) NOT NULL,
    `environmentId` VARCHAR(191) NOT NULL,
    `targetLinkId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `operation` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `requestKey` VARCHAR(191) NOT NULL,
    `requestedByAccountId` VARCHAR(191) NOT NULL,
    `actionOperationId` VARCHAR(191) NOT NULL,
    `predecessorDeploymentId` VARCHAR(191) NULL,
    `rollbackOfDeploymentId` VARCHAR(191) NULL,
    `approvalId` VARCHAR(191) NULL,
    `cancelRequestedAt` DATETIME(3) NULL,
    `contentArtifactId` VARCHAR(191) NOT NULL,
    `contentHeaderVersion` INTEGER NOT NULL,
    `contentBodyVersion` INTEGER NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `settledAt` DATETIME(3) NULL,

    CONSTRAINT `Deployment_values_check` CHECK (`revision` >= 1 AND `contentHeaderVersion` >= 1 AND `contentBodyVersion` >= 1 AND `operation` IN ('deploy', 'rollback', 'promote', 'teardown') AND `state` IN ('queued', 'waitingApproval', 'running', 'running_unverified', 'succeeded', 'failed', 'cancelled', 'outcome_unknown')),
    INDEX `Deployment_environmentId_requestedAt_id_idx`(`environmentId`, `requestedAt`, `id`),
    INDEX `Deployment_environmentId_state_id_idx`(`environmentId`, `state`, `id`),
    INDEX `Deployment_actionOperationId_idx`(`actionOperationId`),
    UNIQUE INDEX `Deployment_environmentId_requestKey_key`(`environmentId`, `requestKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_projectSourceId_fkey` FOREIGN KEY (`projectSourceId`) REFERENCES `ProjectSource`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_controllerMachineId_fkey` FOREIGN KEY (`controllerMachineId`) REFERENCES `Machine`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_buildMachineId_fkey` FOREIGN KEY (`buildMachineId`) REFERENCES `Machine`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_runtimeTargetLinkId_fkey` FOREIGN KEY (`runtimeTargetLinkId`) REFERENCES `DeploymentTargetLink`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentEnvironment` ADD CONSTRAINT `DeploymentEnvironment_contentArtifactId_fkey` FOREIGN KEY (`contentArtifactId`) REFERENCES `Artifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentTargetLink` ADD CONSTRAINT `DeploymentTargetLink_environmentId_fkey` FOREIGN KEY (`environmentId`) REFERENCES `DeploymentEnvironment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentTargetLink` ADD CONSTRAINT `DeploymentTargetLink_activeDeploymentId_fkey` FOREIGN KEY (`activeDeploymentId`) REFERENCES `Deployment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentTargetLink` ADD CONSTRAINT `DeploymentTargetLink_contentArtifactId_fkey` FOREIGN KEY (`contentArtifactId`) REFERENCES `Artifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentTargetLink` ADD CONSTRAINT `DeploymentTargetLink_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentTargetLinkMachine` ADD CONSTRAINT `DeploymentTargetLinkMachine_targetLinkId_fkey` FOREIGN KEY (`targetLinkId`) REFERENCES `DeploymentTargetLink`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DeploymentTargetLinkMachine` ADD CONSTRAINT `DeploymentTargetLinkMachine_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_environmentId_fkey` FOREIGN KEY (`environmentId`) REFERENCES `DeploymentEnvironment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_targetLinkId_fkey` FOREIGN KEY (`targetLinkId`) REFERENCES `DeploymentTargetLink`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_requestedByAccountId_fkey` FOREIGN KEY (`requestedByAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_predecessorDeploymentId_fkey` FOREIGN KEY (`predecessorDeploymentId`) REFERENCES `Deployment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_rollbackOfDeploymentId_fkey` FOREIGN KEY (`rollbackOfDeploymentId`) REFERENCES `Deployment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Deployment` ADD CONSTRAINT `Deployment_contentArtifactId_fkey` FOREIGN KEY (`contentArtifactId`) REFERENCES `Artifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

