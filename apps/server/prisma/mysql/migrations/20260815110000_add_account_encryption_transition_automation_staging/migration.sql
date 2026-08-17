CREATE TABLE `AccountEncryptionTransitionAutomationStageState` (
    `transitionId` VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `sourceParticipantCount` INTEGER NOT NULL,
    `sourceRunCount` INTEGER NOT NULL,
    `sourceEncodedBytes` BIGINT NOT NULL,
    `stagedParticipantCount` INTEGER NOT NULL,
    `stagedRunCount` INTEGER NOT NULL,
    `stagedSourceBytes` BIGINT NOT NULL,
    `stagedTargetBytes` BIGINT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`transitionId`),
    CONSTRAINT `AETASS_transition_fk`
        FOREIGN KEY (`transitionId`) REFERENCES `AccountEncryptionTransition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `AETASS_counts_ck`
        CHECK (
            `sourceParticipantCount` >= 0
            AND `sourceRunCount` >= 0
            AND `sourceRunCount` <= `sourceParticipantCount`
            AND `sourceEncodedBytes` >= 0
            AND `stagedParticipantCount` >= 0
            AND `stagedRunCount` >= 0
            AND `stagedRunCount` <= `stagedParticipantCount`
            AND `stagedSourceBytes` >= 0
            AND `stagedTargetBytes` >= 0
        )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AccountEncryptionTransitionAutomationStage` (
    `id` VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `transitionId` VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `participantKind` VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `participantId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `automationId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `sourceRevision` INTEGER NOT NULL,
    `sourceContent` LONGTEXT NOT NULL,
    `targetContent` LONGTEXT NULL,
    `sourceEncodedBytes` BIGINT NOT NULL,
    `targetEncodedBytes` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `AccountEncryptionTransitionAutomationStage_identity_key`(`transitionId`, `participantKind`, `participantId`),
    INDEX `AccountEncryptionTransitionAutomationStage_transition_page_idx`(`transitionId`, `participantKind`, `participantId`),
    CONSTRAINT `AETAS_transition_fk`
        FOREIGN KEY (`transitionId`) REFERENCES `AccountEncryptionTransition`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `AETAS_kind_ck`
        CHECK (`participantKind` IN ('definition', 'run')),
    CONSTRAINT `AETAS_currentness_ck`
        CHECK (`sourceRevision` >= 0),
    CONSTRAINT `AETAS_bytes_ck`
        CHECK (
            `sourceEncodedBytes` >= 0
            AND (
                (`targetContent` IS NULL AND `targetEncodedBytes` IS NULL)
                OR (`targetContent` IS NOT NULL AND `targetEncodedBytes` >= 0)
            )
        )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
