-- Preserve the one current group incarnation that released V3 clients may
-- mutate without carrying an incarnation token. This record intentionally
-- outlives the group row so delete/recreate boundaries fail closed for V3.
CREATE TABLE `connected_service_auth_group_legacy_v3_mutation_fence` (
    `account_id` VARCHAR(191) NOT NULL,
    `qualified_group_digest` CHAR(64) NOT NULL,
    `legacy_v3_eligible_incarnation` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`account_id`, `qualified_group_digest`),
    CONSTRAINT `csag_legacy_v3_fence_account_fkey`
        FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Every group that exists at deployment is its legacy V3-eligible
-- incarnation. Later create/delete cycles must preserve this first value.
INSERT INTO `connected_service_auth_group_legacy_v3_mutation_fence` (
    `account_id`,
    `qualified_group_digest`,
    `legacy_v3_eligible_incarnation`
)
SELECT
    `accountId`,
    `qualified_group_digest`,
    `id`
FROM `ConnectedServiceAuthGroup`;
