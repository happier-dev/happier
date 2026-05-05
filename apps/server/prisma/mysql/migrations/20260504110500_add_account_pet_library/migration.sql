-- AlterTable
ALTER TABLE `AccountChange` ADD COLUMN `accountPetPackageId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `AccountPetPackage` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `packageFormat` VARCHAR(191) NOT NULL,
    `contentMode` VARCHAR(191) NOT NULL DEFAULT 'plain',
    `manifest` JSON NOT NULL,
    `digest` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `origin` JSON NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AccountPetAsset` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `petPackageId` VARCHAR(191) NOT NULL,
    `contentMode` VARCHAR(191) NOT NULL DEFAULT 'plain',
    `storageKind` VARCHAR(191) NOT NULL,
    `objectKey` VARCHAR(191) NOT NULL,
    `byteLength` INTEGER NOT NULL,
    `mediaType` VARCHAR(191) NOT NULL,
    `digest` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `AccountPetPackage_accountId_id_key` ON `AccountPetPackage`(`accountId`, `id`);

-- CreateIndex
CREATE INDEX `AccountPetPackage_accountId_deletedAt_updatedAt_idx` ON `AccountPetPackage`(`accountId`, `deletedAt`, `updatedAt` DESC);

-- CreateIndex
CREATE INDEX `AccountPetPackage_accountId_digest_idx` ON `AccountPetPackage`(`accountId`, `digest`);

-- CreateIndex
CREATE INDEX `AccountPetAsset_accountId_idx` ON `AccountPetAsset`(`accountId`);

-- CreateIndex
CREATE INDEX `AccountPetAsset_accountId_petPackageId_idx` ON `AccountPetAsset`(`accountId`, `petPackageId`);

-- CreateIndex
CREATE INDEX `AccountPetAsset_petPackageId_idx` ON `AccountPetAsset`(`petPackageId`);

-- CreateIndex
CREATE UNIQUE INDEX `AccountPetAsset_accountId_objectKey_key` ON `AccountPetAsset`(`accountId`, `objectKey`);

-- AddForeignKey
ALTER TABLE `AccountPetPackage` ADD CONSTRAINT `AccountPetPackage_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountPetAsset` ADD CONSTRAINT `AccountPetAsset_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountPetAsset` ADD CONSTRAINT `AccountPetAsset_accountId_petPackageId_fkey` FOREIGN KEY (`accountId`, `petPackageId`) REFERENCES `AccountPetPackage`(`accountId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AccountChange` ADD CONSTRAINT `AccountChange_accountPetPackageId_fkey` FOREIGN KEY (`accountPetPackageId`) REFERENCES `AccountPetPackage`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
