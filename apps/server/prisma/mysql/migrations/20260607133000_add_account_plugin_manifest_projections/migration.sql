CREATE TABLE `account_plugin_manifest_projections` (
    `account_id` VARCHAR(191) NOT NULL,
    `machine_id` VARCHAR(191) NOT NULL,
    `plugin_id` VARCHAR(191) NOT NULL,
    `schema_version` INTEGER NOT NULL,
    `plugin_version` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NOT NULL,
    `manifest_digest` VARCHAR(191) NOT NULL,
    `source_json` LONGTEXT NULL,
    `required_permissions_json` LONGTEXT NOT NULL,
    `optional_permissions_json` LONGTEXT NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `disabled_at` BIGINT NULL,
    `created_at` BIGINT NOT NULL,
    `updated_at` BIGINT NOT NULL,

    INDEX `account_plugin_manifest_projection_plugin_lookup_idx`(`account_id`, `plugin_id`, `enabled`),
    INDEX `account_plugin_manifest_projection_machine_lookup_idx`(`account_id`, `machine_id`, `plugin_id`, `enabled`),
    INDEX `account_plugin_manifest_projection_list_idx`(`account_id`, `enabled`, `updated_at`),
    PRIMARY KEY (`account_id`, `machine_id`, `plugin_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `account_plugin_manifest_projections`
ADD CONSTRAINT `account_plugin_manifest_projections_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `account_plugin_manifest_projections`
ADD CONSTRAINT `account_plugin_manifest_projections_machine_fkey` FOREIGN KEY (`account_id`, `machine_id`) REFERENCES `Machine`(`accountId`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
