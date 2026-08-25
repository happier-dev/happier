CREATE TABLE `review_comment_publication_correlations` (
    `publication_correlation_id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `comment_id` VARCHAR(191) NOT NULL,
    `target_key` VARCHAR(191) NOT NULL,
    `target_json` TEXT NOT NULL,
    `created_at` BIGINT NOT NULL,

    PRIMARY KEY (`publication_correlation_id`),
    UNIQUE INDEX `review_comment_publication_target_key` (`account_id`, `comment_id`, `target_key`),
    CONSTRAINT `review_comment_publication_correlations_account_id_fkey`
        FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `review_comment_publication_correlations_comment_id_fkey`
        FOREIGN KEY (`comment_id`) REFERENCES `review_comments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
