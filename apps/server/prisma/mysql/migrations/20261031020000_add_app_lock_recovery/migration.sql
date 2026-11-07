-- CreateTable
CREATE TABLE `AppLockRecovery` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `recoveryKey` VARCHAR(191) NOT NULL,
    `codeHash` VARCHAR(191) NULL,
    `codePurpose` VARCHAR(191) NULL,
    `codeExpiresAt` DATETIME(3) NULL,
    `codeSentAt` DATETIME(3) NULL,
    `codeAttempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `AppLockRecovery_accountId_idx`(`accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppLockMailSettings` (
    `accountId` VARCHAR(191) NOT NULL,
    `host` VARCHAR(191) NOT NULL,
    `port` INTEGER NOT NULL,
    `security` VARCHAR(191) NOT NULL,
    `username` VARCHAR(191) NOT NULL,
    `passwordEncrypted` LONGBLOB NULL,
    `fromAddress` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`accountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AppLockRecovery` ADD CONSTRAINT `AppLockRecovery_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AppLockMailSettings` ADD CONSTRAINT `AppLockMailSettings_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
