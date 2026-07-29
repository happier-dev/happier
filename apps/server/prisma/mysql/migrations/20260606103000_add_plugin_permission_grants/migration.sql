CREATE TABLE `plugin_permission_grant_requests` (
    `id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `plugin_id` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(191) NOT NULL,
    `scope_kind` VARCHAR(191) NOT NULL,
    `scope_project_id` VARCHAR(191) NULL,
    `scope_workspace_id` VARCHAR(191) NULL,
    `requester_json` LONGTEXT NOT NULL,
    `reason` LONGTEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `grant_id` VARCHAR(191) NULL,
    `created_by_user_id` VARCHAR(191) NULL,
    `decided_by_user_id` VARCHAR(191) NULL,
    `decided_at` BIGINT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `plugin_permission_requests_scope_idx`(`account_id`(64), `plugin_id`(64), `capability`(64), `scope_kind`(64), `scope_project_id`(64), `scope_workspace_id`(64), `status`(64), `updated_at`),
    INDEX `plugin_permission_requests_grant_idx`(`account_id`, `grant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `plugin_permission_grants` (
    `id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `plugin_id` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(191) NOT NULL,
    `scope_kind` VARCHAR(191) NOT NULL,
    `scope_project_id` VARCHAR(191) NULL,
    `scope_workspace_id` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL,
    `request_id` VARCHAR(191) NULL,
    `granted_by_user_id` VARCHAR(191) NOT NULL,
    `granted_at` BIGINT NOT NULL,
    `revoked_by_user_id` VARCHAR(191) NULL,
    `revoked_at` BIGINT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `plugin_permission_grants_scope_idx`(`account_id`(64), `plugin_id`(64), `capability`(64), `scope_kind`(64), `scope_project_id`(64), `scope_workspace_id`(64), `status`(64), `updated_at`),
    INDEX `plugin_permission_grants_request_idx`(`account_id`, `request_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `plugin_permission_grant_events` (
    `event_id` VARCHAR(191) NOT NULL,
    `account_id` VARCHAR(191) NOT NULL,
    `plugin_id` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(191) NOT NULL,
    `scope_kind` VARCHAR(191) NOT NULL,
    `scope_project_id` VARCHAR(191) NULL,
    `scope_workspace_id` VARCHAR(191) NULL,
    `event_kind` VARCHAR(191) NOT NULL,
    `actor_json` LONGTEXT NOT NULL,
    `request_id` VARCHAR(191) NULL,
    `grant_id` VARCHAR(191) NULL,
    `previous_state_json` LONGTEXT NULL,
    `next_state_json` LONGTEXT NULL,
    `reason` LONGTEXT NULL,
    `created_at` BIGINT NOT NULL,

    INDEX `plugin_permission_events_kind_idx`(`account_id`(64), `plugin_id`(64), `capability`(64), `event_kind`(64), `created_at`),
    INDEX `plugin_permission_events_request_idx`(`account_id`, `request_id`),
    INDEX `plugin_permission_events_grant_idx`(`account_id`, `grant_id`),
    PRIMARY KEY (`event_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `plugin_permission_grant_requests`
ADD CONSTRAINT `plugin_permission_grant_requests_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `plugin_permission_grants`
ADD CONSTRAINT `plugin_permission_grants_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `plugin_permission_grant_events`
ADD CONSTRAINT `plugin_permission_grant_events_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE `plugin_permission_grants`
ADD COLUMN `active_identity_key` VARCHAR(512) NULL;

CREATE UNIQUE INDEX `plugin_permission_grants_active_identity_key`
ON `plugin_permission_grants`(`account_id`, `active_identity_key`);


ALTER TABLE `plugin_permission_grant_requests`
ADD COLUMN `authority_kind` VARCHAR(191) NOT NULL DEFAULT 'bundled',
ADD COLUMN `authority_machine_id` VARCHAR(191) NULL,
ADD COLUMN `authority_installation_id` VARCHAR(191) NULL;

ALTER TABLE `plugin_permission_grants`
ADD COLUMN `authority_kind` VARCHAR(191) NOT NULL DEFAULT 'bundled',
ADD COLUMN `authority_machine_id` VARCHAR(191) NULL,
ADD COLUMN `authority_installation_id` VARCHAR(191) NULL;

ALTER TABLE `plugin_permission_grant_events`
ADD COLUMN `authority_kind` VARCHAR(191) NOT NULL DEFAULT 'bundled',
ADD COLUMN `authority_machine_id` VARCHAR(191) NULL,
ADD COLUMN `authority_installation_id` VARCHAR(191) NULL;

DROP INDEX `plugin_permission_grants_scope_idx` ON `plugin_permission_grants`;
CREATE INDEX `plugin_permission_grants_scope_idx`
ON `plugin_permission_grants`(
    `account_id`(64),
    `plugin_id`(64),
    `capability`(64),
    `scope_kind`(64),
    `scope_project_id`(64),
    `scope_workspace_id`(64),
    `authority_kind`(64),
    `authority_machine_id`(64),
    `authority_installation_id`(64),
    `status`(64),
    `updated_at`
);

DROP INDEX `plugin_permission_requests_scope_idx` ON `plugin_permission_grant_requests`;
CREATE INDEX `plugin_permission_requests_scope_idx`
ON `plugin_permission_grant_requests`(
    `account_id`(64),
    `plugin_id`(64),
    `capability`(64),
    `scope_kind`(64),
    `scope_project_id`(64),
    `scope_workspace_id`(64),
    `authority_kind`(64),
    `authority_machine_id`(64),
    `authority_installation_id`(64),
    `status`(64),
    `updated_at`
);

ALTER TABLE `plugin_permission_grant_requests`
ADD COLUMN `active_identity_key` VARCHAR(512) NULL;

CREATE UNIQUE INDEX `plugin_permission_requests_active_identity_key`
ON `plugin_permission_grant_requests`(`account_id`, `active_identity_key`);
