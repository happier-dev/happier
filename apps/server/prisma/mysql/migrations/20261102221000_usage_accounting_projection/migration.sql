-- Derived accounting state only; UsageEvent and UsageReport remain authoritative.
CREATE TABLE `UsageAccountingProjection` (
    `recordKey` VARCHAR(64) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `subjectHash` VARCHAR(64) NULL,
    `itemKey` VARCHAR(64) NULL,
    `sessionId` VARCHAR(191) NULL,
    `observedAtMs` BIGINT NOT NULL,
    `validFromMs` BIGINT NOT NULL,
    `validUntilMs` BIGINT NULL,
    `ordinal` INTEGER NULL,
    `payload` LONGTEXT NOT NULL,

    INDEX `UsageAccountingProjection_accountId_kind_observedAtMs_idx`(`accountId`, `kind`, `observedAtMs`),
    INDEX `UsageAccountingProjection_accountId_kind_subjectHash_idx`(`accountId`, `kind`, `subjectHash`),
    INDEX `UsageAccountingProjection_accountId_kind_sessionId_idx`(`accountId`, `kind`, `sessionId`),
    INDEX `UsageAccountingProjection_accountId_kind_itemKey_idx`(`accountId`, `kind`, `itemKey`),
    PRIMARY KEY (`recordKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `UsageAccountingProjection` ADD CONSTRAINT `UsageAccountingProjection_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
