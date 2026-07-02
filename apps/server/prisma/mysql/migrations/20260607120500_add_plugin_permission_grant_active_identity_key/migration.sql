ALTER TABLE `plugin_permission_grants`
ADD COLUMN `active_identity_key` VARCHAR(512) NULL;

UPDATE `plugin_permission_grants`
SET `active_identity_key` =
    CONCAT(
        `plugin_id`, CHAR(31),
        `capability`, CHAR(31),
        `scope_kind`, CHAR(31),
        COALESCE(`scope_project_id`, ''), CHAR(31),
        COALESCE(`scope_workspace_id`, '')
    )
WHERE `status` = 'active';

CREATE UNIQUE INDEX `plugin_permission_grants_active_identity_key`
ON `plugin_permission_grants`(`account_id`, `active_identity_key`);
