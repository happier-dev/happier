-- CreateTable
CREATE TABLE `SupporterRecord` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `number` INTEGER NULL,
    `accountId` VARCHAR(191) NULL,
    `kind` VARCHAR(191) NULL,
    `grantedAt` DATETIME(3) NULL,
    `recurringActive` BOOLEAN NOT NULL DEFAULT false,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SupporterRecord_code_key`(`code`),
    UNIQUE INDEX `SupporterRecord_number_key`(`number`),
    UNIQUE INDEX `SupporterRecord_accountId_key`(`accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SupporterRecord` ADD CONSTRAINT `SupporterRecord_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
