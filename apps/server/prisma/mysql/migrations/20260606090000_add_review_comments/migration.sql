CREATE TABLE `review_comments` (
    `id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NOT NULL,
    `workspace_id` VARCHAR(191) NULL,
    `session_id` VARCHAR(191) NULL,
    `run_id` VARCHAR(191) NULL,
    `engine_id` VARCHAR(191) NULL,
    `finding_id` VARCHAR(191) NULL,
    `thread_id` VARCHAR(191) NOT NULL,
    `parent_comment_id` VARCHAR(191) NULL,
    `state` VARCHAR(191) NOT NULL,
    `flags_json` LONGTEXT NOT NULL,
    `anchor_json` LONGTEXT NOT NULL,
    `anchor_file_path` VARCHAR(191) NULL,
    `anchor_folder_path` VARCHAR(191) NULL,
    `snapshot_envelope_json` LONGTEXT NOT NULL,
    `body_envelope_json` LONGTEXT NOT NULL,
    `body_version` INTEGER NOT NULL,
    `author_json` LONGTEXT NOT NULL,
    `edits_json` LONGTEXT NOT NULL,
    `dispositions_json` LONGTEXT NOT NULL,
    `evidence_json` LONGTEXT NULL,
    `transitions_json` LONGTEXT NOT NULL,
    `fingerprint_json` LONGTEXT NULL,
    `linked_refs_json` LONGTEXT NULL,
    `suggested_fix_json` LONGTEXT NULL,
    `metadata_json` LONGTEXT NULL,
    `tombstone_json` LONGTEXT NULL,
  `create_client_mutation_id` VARCHAR(191)
      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
    `create_request_fingerprint` VARCHAR(191) NULL,
    `server_revision` INTEGER NOT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `review_comments_project_state_idx`(`project_id`, `state`, `updated_at`),
    INDEX `review_comments_project_run_idx`(`project_id`, `run_id`, `updated_at`),
    INDEX `review_comments_project_engine_idx`(`project_id`, `engine_id`, `updated_at`),
    INDEX `review_comments_project_file_idx`(`project_id`, `anchor_file_path`, `updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `review_comment_events` (
    `event_id` VARCHAR(191) NOT NULL,
    `comment_id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `project_id` VARCHAR(191) NOT NULL,
    `event_kind` VARCHAR(191) NOT NULL,
    `event_envelope_json` LONGTEXT NOT NULL,
    `bulk_action_id` VARCHAR(191) NULL,
    `client_mutation_id` VARCHAR(191) NULL,
    `actor_json` LONGTEXT NOT NULL,
    `author_device_id` VARCHAR(191) NULL,
    `client_lamport` BIGINT NULL,
    `server_revision` INTEGER NOT NULL,
    `created_at` BIGINT NOT NULL,

    INDEX `review_comment_events_comment_idx`(`comment_id`, `server_revision`),
    INDEX `review_comment_events_account_project_idx`(`account_id`, `project_id`, `created_at`),
    PRIMARY KEY (`event_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `review_comments`
ADD CONSTRAINT `review_comments_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `review_comment_events`
ADD CONSTRAINT `review_comment_events_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `review_comment_events`
ADD CONSTRAINT `review_comment_events_comment_id_fkey` FOREIGN KEY (`comment_id`) REFERENCES `review_comments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX `review_comments_account_create_mutation_key`
ON `review_comments`(`account_id`, `create_client_mutation_id`);
