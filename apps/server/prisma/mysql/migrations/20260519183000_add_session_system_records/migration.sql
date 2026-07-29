CREATE TABLE `SessionSystemRecord` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `namespace` VARCHAR(32) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `localId` VARCHAR(191) NOT NULL,
    `content` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `SessionSystemRecord_accountId_sessionId_namespace_localId_key`
ON `SessionSystemRecord`(`accountId`, `sessionId`, `namespace`, `localId`);

CREATE INDEX `ssr_account_session_kind_updated_id_idx`
ON `SessionSystemRecord`(`accountId`, `sessionId`, `namespace`, `kind`, `updatedAt`, `id`);

CREATE INDEX `SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx`
ON `SessionSystemRecord`(`sessionId`, `namespace`, `kind`, `updatedAt`, `id`);

ALTER TABLE `SessionSystemRecord` ADD CONSTRAINT `SessionSystemRecord_accountId_fkey`
FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SessionSystemRecord` ADD CONSTRAINT `SessionSystemRecord_sessionId_fkey`
FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
