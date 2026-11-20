CREATE TABLE `QualifiedConnectedAccountUsageRefusal` (
    `accountId` VARCHAR(191) NOT NULL,
    `qualifiedIdentityDigest` VARCHAR(191) NOT NULL,
    `credentialId` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `qcau_refusal_credential_idx`(`credentialId`),
    PRIMARY KEY (`accountId`, `qualifiedIdentityDigest`, `credentialId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `QualifiedConnectedAccountUsageRefusal` ADD CONSTRAINT `qcau_refusal_account_fkey`
    FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `QualifiedConnectedAccountUsageRefusal` ADD CONSTRAINT `qcau_refusal_credential_fkey`
    FOREIGN KEY (`credentialId`) REFERENCES `ServiceAccountToken`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
