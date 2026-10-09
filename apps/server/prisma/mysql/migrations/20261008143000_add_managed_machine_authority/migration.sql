CREATE TABLE `ManagedMachine` (
    `id` VARCHAR(191) NOT NULL PRIMARY KEY,
    `homeId` VARCHAR(191) NOT NULL,
    `custodianAccountId` VARCHAR(191) NOT NULL,
    `controllerMachineId` VARCHAR(191) NOT NULL,
    `controllerInstallationId` VARCHAR(191) NOT NULL,
    `admittedActionRequestId` VARCHAR(191) NOT NULL,
    `admittedInput` JSON NOT NULL,
    `presetId` VARCHAR(191),
    `presetRevision` INTEGER,
    `launch` JSON NOT NULL,
    `reviewedFacts` JSON,
    `allocation` VARCHAR(191) NOT NULL DEFAULT 'unsubmitted',
    `creationState` VARCHAR(191) NOT NULL DEFAULT 'active',
    `resource` JSON,
    `nativeOperationRef` JSON,
    `recovery` JSON,
    `bootstrapCredentialRef` JSON,
    `enrolledMachineId` VARCHAR(191),
    `desired` VARCHAR(191) NOT NULL DEFAULT 'start',
    `desiredWhen` VARCHAR(191) NOT NULL DEFAULT 'now',
    `desiredAfterMs` DOUBLE,
    `intentRevision` INTEGER NOT NULL DEFAULT 0,
    `archivedAt` DATETIME(3),
    `retention` JSON NOT NULL,
    `wakeOnAcceptedMessage` BOOLEAN NOT NULL,
    `observation` JSON,
    `cleanup` JSON,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME(3) NOT NULL,
    CONSTRAINT `ManagedMachine_custodianAccountId_fkey` FOREIGN KEY (`custodianAccountId`) REFERENCES `Account` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `ManagedMachine_enrolledMachineId_fkey` FOREIGN KEY (`enrolledMachineId`) REFERENCES `Machine` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `ManagedMachinePreset` (
    `id` VARCHAR(191) NOT NULL PRIMARY KEY,
    `homeId` VARCHAR(191) NOT NULL,
    `custodianAccountId` VARCHAR(191),
    `teamId` VARCHAR(191),
    `name` LONGTEXT NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 0,
    `launch` JSON NOT NULL,
    `controllerMachineId` VARCHAR(191) NOT NULL,
    `controllerInstallationId` VARCHAR(191) NOT NULL,
    `retentionOverride` JSON,
    `wakeOnAcceptedMessage` BOOLEAN,
    `simultaneousMaximum` INTEGER,
    `archivedAt` DATETIME(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` DATETIME(3) NOT NULL,
    CONSTRAINT `ManagedMachinePreset_custodianAccountId_fkey` FOREIGN KEY (`custodianAccountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ManagedMachinePreset_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ManagedMachinePreset_owner_check` CHECK ((`custodianAccountId` IS NULL) <> (`teamId` IS NULL)),
    CONSTRAINT `ManagedMachinePreset_limit_check` CHECK (`simultaneousMaximum` IS NULL OR `simultaneousMaximum` > 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE UNIQUE INDEX `ManagedMachine_enrolledMachineId_key` ON `ManagedMachine`(`enrolledMachineId`);
CREATE UNIQUE INDEX `ManagedMachine_homeId_admittedActionRequestId_key` ON `ManagedMachine`(`homeId`, `admittedActionRequestId`);
CREATE INDEX `ManagedMachine_homeId_custodianAccountId_archivedAt_createdAt_idx` ON `ManagedMachine`(`homeId`, `custodianAccountId`, `archivedAt`, `createdAt`);
CREATE INDEX `ManagedMachine_controllerMachineId_controllerInstallationId_idx` ON `ManagedMachine`(`controllerMachineId`, `controllerInstallationId`);
CREATE INDEX `ManagedMachinePreset_homeId_custodianAccountId_idx` ON `ManagedMachinePreset`(`homeId`, `custodianAccountId`);
CREATE INDEX `ManagedMachinePreset_homeId_teamId_idx` ON `ManagedMachinePreset`(`homeId`, `teamId`);
