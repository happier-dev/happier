-- Bot templates: authenticated link admission and best-effort direct-copy version reports.
-- CreateTable
CREATE TABLE `ArtifactSignedInLink` (
    `artifactId` VARCHAR(191) NOT NULL,
    `createdByUserId` VARCHAR(191) NOT NULL,
    `tokenHash` VARBINARY(32) NOT NULL,
    `encryptedDataKey` LONGBLOB NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ArtifactSignedInLink_tokenHash_key`(`tokenHash`),
    PRIMARY KEY (`artifactId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ArtifactTemplateAcceptedVersion` (
    `artifactId` VARCHAR(191) NOT NULL,
    `recipientAccountId` VARCHAR(191) NOT NULL,
    `copyId` VARCHAR(191) NOT NULL,
    `acceptedVersion` VARCHAR(191) NOT NULL,
    `reportedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`artifactId`, `recipientAccountId`, `copyId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ArtifactSignedInLink` ADD CONSTRAINT `ArtifactSignedInLink_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `Artifact`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ArtifactSignedInLink` ADD CONSTRAINT `ArtifactSignedInLink_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ArtifactTemplateAcceptedVersion` ADD CONSTRAINT `ArtifactTemplateAcceptedVersion_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `Artifact`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ArtifactTemplateAcceptedVersion` ADD CONSTRAINT `ArtifactTemplateAcceptedVersion_recipientAccountId_fkey` FOREIGN KEY (`recipientAccountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

