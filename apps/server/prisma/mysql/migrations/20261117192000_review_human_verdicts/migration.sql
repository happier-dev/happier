CREATE TABLE `ReviewRequestedReviewer` (
    `id` VARCHAR(191) NOT NULL,
    `reviewId` VARCHAR(191) NOT NULL,
    `roundOrdinal` INTEGER NOT NULL,
    `principalKey` VARCHAR(191) NOT NULL,
    `principal` JSON NOT NULL,
    `required` BOOLEAN NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    CONSTRAINT `ReviewRequestedReviewer_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `Artifact` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ReviewRequestedReviewerAccount` (
    `requestId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    PRIMARY KEY (`requestId`, `accountId`),
    CONSTRAINT `ReviewRequestedReviewerAccount_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `ReviewRequestedReviewer` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ReviewRequestedReviewerAccount_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ReviewVerdict` (
    `reviewId` VARCHAR(191) NOT NULL,
    `roundOrdinal` INTEGER NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `verdict` VARCHAR(191) NOT NULL,
    `content` JSON,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`reviewId`, `roundOrdinal`, `accountId`),
    CONSTRAINT `ReviewVerdict_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `Artifact` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ReviewVerdict_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `ReviewRequestedReviewer_reviewId_roundOrdinal_principalKey_key` ON `ReviewRequestedReviewer` (`reviewId`, `roundOrdinal`, `principalKey`);

CREATE INDEX `ReviewRequestedReviewer_reviewId_roundOrdinal_idx` ON `ReviewRequestedReviewer` (`reviewId`, `roundOrdinal`);

CREATE INDEX `ReviewRequestedReviewerAccount_accountId_requestId_idx` ON `ReviewRequestedReviewerAccount` (`accountId`, `requestId`);

CREATE INDEX `ReviewVerdict_accountId_reviewId_idx` ON `ReviewVerdict` (`accountId`, `reviewId`);
