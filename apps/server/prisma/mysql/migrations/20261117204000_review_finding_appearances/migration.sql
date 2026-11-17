ALTER TABLE `review_comments` ADD COLUMN `review_id` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `review_comments_review_finding_identity_key` ON `review_comments` (`review_id`, `finding_identity`);
CREATE INDEX `review_comments_review_id_state_updated_at_idx` ON `review_comments` (`review_id`, `state`, `updated_at`);
ALTER TABLE `review_comments` ADD CONSTRAINT `review_comments_review_id_fkey` FOREIGN KEY (`review_id`) REFERENCES `Artifact` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE `review_comment_appearances` (
    `review_id` VARCHAR(191) NOT NULL,
    `comment_id` VARCHAR(191) NOT NULL,
    `round_ordinal` INTEGER NOT NULL,
    `source_key` VARCHAR(191) NOT NULL,
    `run_id` VARCHAR(191) NOT NULL,
    `reviewer_id` VARCHAR(191) NOT NULL,
    `machine_id` VARCHAR(191) NULL,
    `session_id` VARCHAR(191) NULL,
    PRIMARY KEY (`comment_id`, `round_ordinal`, `source_key`),
    INDEX `review_comment_appearances_review_id_round_ordinal_idx` (`review_id`, `round_ordinal`),
    CONSTRAINT `review_comment_appearances_comment_id_fkey` FOREIGN KEY (`comment_id`) REFERENCES `review_comments` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
