-- CreateTable
CREATE TABLE `ConnectedClientPresence` (
    `accountId` VARCHAR(191) NOT NULL,
    `clientId` VARCHAR(191) NOT NULL,
    `lastSeenAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`accountId`, `clientId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ConnectedClientPresence` ADD CONSTRAINT `ConnectedClientPresence_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

