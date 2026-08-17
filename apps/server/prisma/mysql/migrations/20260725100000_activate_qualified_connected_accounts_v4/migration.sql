-- Fail closed on every legacy-data violation before MySQL reaches permanent
-- DDL. ALTER TABLE and CREATE INDEX implicitly commit, while these temporary
-- tables remain scoped to this migration session and leave no product schema
-- behind when the preflight rejects the predecessor data.

DROP TEMPORARY TABLE IF EXISTS `_QualifiedLegacyServiceMap`;
-- MySQL's default text collation folds case and trailing spaces. Keep the map
-- and every predecessor identity/relation join byte-exact so malformed legacy
-- facts fail the preflight instead of being silently converted or cross-linked.
CREATE TEMPORARY TABLE `_QualifiedLegacyServiceMap` (
    `serviceId` VARBINARY(191) NOT NULL PRIMARY KEY, `pluginId` VARCHAR(191) NOT NULL,
    `localId` VARCHAR(191) NOT NULL, `serviceDigest` CHAR(64) NOT NULL,
    `defaultModeId` VARCHAR(191) NOT NULL, `oauthModeId` VARCHAR(191),
    `tokenModeId` VARCHAR(191)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO `_QualifiedLegacyServiceMap` VALUES
    ('openai-codex', 'happier.agent.codex', 'openai-codex', 'a8d53eff624b4a3b71570b0367fc4738a8ea4dc5f3018bbc501f281dad087bea', 'oauth', 'oauth', NULL),
    ('openai', 'happier.voice.openai', 'openai', 'ec3a0fd63cbee7f50c3e2977fc882d6183379e6392b5d51b3efa390cc53f7c9b', 'api-key', NULL, 'api-key'),
    ('anthropic', 'happier.agent.claude', 'anthropic', '749d2df955d1d61572285abffa1d2324101c1433c355946eba65bb121a63987a', 'api-key', NULL, 'api-key'),
    ('claude-subscription', 'happier.agent.claude', 'claude-subscription', '40a8a0ad2615b95f046a13632ac3d0aae5da32ef634dd11053ecad6e1884675e', 'setup-token', 'oauth', 'setup-token'),
    ('gemini', 'happier.agent.gemini', 'gemini-account', '38b3ec1a4e87b7ce2a5bd41838eb0e5155170df35d937709d8db4836442f9e23', 'api-key', 'legacy-oauth-unsupported', 'api-key'),
    ('github', 'happier.scm.forge.github', 'github-account', 'bafdd80f57f752d0867fef33b99a3750286f07a2c2dc4896c3b7f7bb7c707ebd', 'fine-grained-pat', NULL, 'fine-grained-pat'),
    ('bitbucket', 'happier.scm.forge.bitbucket', 'bitbucket-account', '4b276e5f5b66a036ede597b0926d7f7991772bfe891698b76fd7be0e52fa2616', 'manual', NULL, 'manual');

DROP TEMPORARY TABLE IF EXISTS `_QualifiedActivationGuard`;
CREATE TEMPORARY TABLE `_QualifiedActivationGuard` (`guardValue` INTEGER PRIMARY KEY);
INSERT INTO `_QualifiedActivationGuard` VALUES (0);

INSERT INTO `_QualifiedActivationGuard`
SELECT 0 WHERE EXISTS (
    SELECT 1
    FROM `ServiceAccountToken` credential
    LEFT JOIN `_QualifiedLegacyServiceMap` mapping
      ON CAST(mapping.`serviceId` AS BINARY) = CAST(credential.`vendor` AS BINARY)
    WHERE mapping.`serviceId` IS NULL OR credential.`profileId` IS NULL
       OR (
            JSON_UNQUOTE(JSON_EXTRACT(credential.`metadata`, '$.kind')) IS NOT NULL
            AND JSON_UNQUOTE(JSON_EXTRACT(credential.`metadata`, '$.kind')) NOT IN ('oauth','token')
       )
       OR (JSON_UNQUOTE(JSON_EXTRACT(credential.`metadata`, '$.kind')) = 'oauth' AND mapping.`oauthModeId` IS NULL)
       OR (JSON_UNQUOTE(JSON_EXTRACT(credential.`metadata`, '$.kind')) = 'token' AND mapping.`tokenModeId` IS NULL)
);

INSERT INTO `_QualifiedActivationGuard`
SELECT 0 WHERE EXISTS (
    SELECT 1
    FROM `ConnectedServiceAuthGroup` auth_group
    LEFT JOIN `_QualifiedLegacyServiceMap` mapping
      ON CAST(mapping.`serviceId` AS BINARY) = CAST(auth_group.`vendor` AS BINARY)
    WHERE mapping.`serviceId` IS NULL OR auth_group.`groupId` IS NULL
       OR (
            auth_group.`activeProfileId` IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM `ConnectedServiceAuthGroupMember` active_member
                WHERE CAST(active_member.`groupDbId` AS BINARY) = CAST(auth_group.`id` AS BINARY)
                  AND CAST(active_member.`accountId` AS BINARY) = CAST(auth_group.`accountId` AS BINARY)
                  AND CAST(active_member.`vendor` AS BINARY) = CAST(auth_group.`vendor` AS BINARY)
                  AND CAST(active_member.`groupId` AS BINARY) = CAST(auth_group.`groupId` AS BINARY)
                  AND CAST(active_member.`profileId` AS BINARY) = CAST(auth_group.`activeProfileId` AS BINARY)
            )
       )
);

INSERT INTO `_QualifiedActivationGuard`
SELECT 0 WHERE EXISTS (
    SELECT 1
    FROM `ConnectedServiceAuthGroupMember` member
    LEFT JOIN `ConnectedServiceAuthGroup` auth_group
      ON CAST(auth_group.`id` AS BINARY) = CAST(member.`groupDbId` AS BINARY)
     AND CAST(auth_group.`accountId` AS BINARY) = CAST(member.`accountId` AS BINARY)
     AND CAST(auth_group.`vendor` AS BINARY) = CAST(member.`vendor` AS BINARY)
     AND CAST(auth_group.`groupId` AS BINARY) = CAST(member.`groupId` AS BINARY)
    LEFT JOIN `ServiceAccountToken` credential
      ON CAST(credential.`accountId` AS BINARY) = CAST(member.`accountId` AS BINARY)
     AND CAST(credential.`vendor` AS BINARY) = CAST(member.`vendor` AS BINARY)
     AND CAST(credential.`profileId` AS BINARY) = CAST(member.`profileId` AS BINARY)
    WHERE auth_group.`id` IS NULL OR credential.`id` IS NULL
);

INSERT INTO `_QualifiedActivationGuard`
SELECT 0 WHERE EXISTS (
    SELECT 1
    FROM `ConnectedServiceUsageSource` source
    LEFT JOIN `ServiceAccountToken` credential
      ON CAST(credential.`accountId` AS BINARY) = CAST(source.`accountId` AS BINARY)
     AND CAST(credential.`vendor` AS BINARY) = CAST(source.`serviceId` AS BINARY)
     AND CAST(credential.`profileId` AS BINARY) = CAST(source.`profileId` AS BINARY)
    WHERE credential.`id` IS NULL
);

INSERT INTO `_QualifiedActivationGuard`
SELECT 0 WHERE EXISTS (
    SELECT 1
    FROM `ServiceAccountToken` credential
    JOIN `_QualifiedLegacyServiceMap` mapping
      ON CAST(mapping.`serviceId` AS BINARY) = CAST(credential.`vendor` AS BINARY)
    GROUP BY credential.`accountId`, SHA2(CONCAT(
        '["account",', JSON_QUOTE(mapping.`pluginId`), ',',
        JSON_QUOTE(mapping.`localId`), ',', JSON_QUOTE(credential.`profileId`), ']'
    ), 256)
    HAVING COUNT(*) > 1
);

INSERT INTO `_QualifiedActivationGuard`
SELECT 0 WHERE EXISTS (
    SELECT 1
    FROM `ConnectedServiceAuthGroup` auth_group
    JOIN `_QualifiedLegacyServiceMap` mapping
      ON CAST(mapping.`serviceId` AS BINARY) = CAST(auth_group.`vendor` AS BINARY)
    GROUP BY auth_group.`accountId`, SHA2(CONCAT(
        '["group",', JSON_QUOTE(mapping.`pluginId`), ',',
        JSON_QUOTE(mapping.`localId`), ',', JSON_QUOTE(auth_group.`groupId`), ']'
    ), 256)
    HAVING COUNT(*) > 1
);

DROP TEMPORARY TABLE `_QualifiedActivationGuard`;

-- Prepare the validated predecessor rows for canonical qualified identity.
-- Nullable expansion plus unique indexes gives activation a database-enforced
-- duplicate/collision guard before any column becomes required.

ALTER TABLE `ServiceAccountToken`
    ADD COLUMN `service_plugin_id` LONGTEXT NULL,
    ADD COLUMN `service_local_id` LONGTEXT NULL,
    ADD COLUMN `qualified_service_digest` CHAR(64) NULL,
    ADD COLUMN `connected_account_id` LONGTEXT NULL,
    ADD COLUMN `qualified_identity_digest` CHAR(64) NULL,
    ADD COLUMN `authentication_mode_id` VARCHAR(191) NULL,
    ADD COLUMN `configuration_revision` VARCHAR(191) NULL,
    ADD COLUMN `configuration_content` LONGBLOB NULL;

ALTER TABLE `ServiceAccountToken`
    ADD CONSTRAINT `sat_configuration_sidecar_pair_check`
    CHECK ((`configuration_revision` IS NULL) = (`configuration_content` IS NULL));

CREATE UNIQUE INDEX `sat_qualified_identity_key`
ON `ServiceAccountToken`(`accountId`, `qualified_identity_digest`);

ALTER TABLE `ConnectedServiceAuthGroup`
    ADD COLUMN `service_plugin_id` LONGTEXT NULL,
    ADD COLUMN `service_local_id` LONGTEXT NULL,
    ADD COLUMN `qualified_service_digest` CHAR(64) NULL,
    ADD COLUMN `qualified_group_digest` CHAR(64) NULL,
    ADD COLUMN `active_connected_account_id` LONGTEXT NULL;

CREATE UNIQUE INDEX `csag_qualified_group_key`
ON `ConnectedServiceAuthGroup`(`accountId`, `qualified_group_digest`);

ALTER TABLE `ConnectedServiceAuthGroupMember`
    ADD COLUMN `credential_id` VARCHAR(191) NULL,
    ADD COLUMN `qualified_service_digest` CHAR(64) NULL,
    ADD COLUMN `qualified_group_digest` CHAR(64) NULL,
    ADD COLUMN `qualified_identity_digest` CHAR(64) NULL;

CREATE UNIQUE INDEX `csagm_group_credential_key`
ON `ConnectedServiceAuthGroupMember`(`groupDbId`, `credential_id`);

ALTER TABLE `ConnectedServiceUsageSource`
    ADD COLUMN `service_plugin_id` LONGTEXT NULL,
    ADD COLUMN `service_local_id` LONGTEXT NULL,
    ADD COLUMN `qualified_service_digest` CHAR(64) NULL,
    ADD COLUMN `connected_account_id` LONGTEXT NULL,
    ADD COLUMN `qualified_identity_digest` CHAR(64) NULL,
    ADD COLUMN `credential_id` VARCHAR(191) NULL;

-- Activate exact qualified identity across credential, group, member, and usage
-- rows. The frozen map combines five 0.2.1 services, prospective Remote GitHub,
-- and evolved-Dev Bitbucket compatibility.

UPDATE `ServiceAccountToken` credential
JOIN `_QualifiedLegacyServiceMap` mapping
  ON CAST(mapping.`serviceId` AS BINARY) = CAST(credential.`vendor` AS BINARY)
SET
    credential.`service_plugin_id` = mapping.`pluginId`,
    credential.`service_local_id` = mapping.`localId`,
    credential.`qualified_service_digest` = mapping.`serviceDigest`,
    credential.`connected_account_id` = credential.`profileId`,
    credential.`qualified_identity_digest` = SHA2(CONCAT(
        '["account",', JSON_QUOTE(mapping.`pluginId`), ',',
        JSON_QUOTE(mapping.`localId`), ',', JSON_QUOTE(credential.`profileId`), ']'
    ), 256),
    credential.`authentication_mode_id` = CASE JSON_UNQUOTE(JSON_EXTRACT(credential.`metadata`, '$.kind'))
        WHEN 'oauth' THEN mapping.`oauthModeId`
        WHEN 'token' THEN mapping.`tokenModeId`
        ELSE mapping.`defaultModeId`
    END;

UPDATE `ConnectedServiceAuthGroup` auth_group
JOIN `_QualifiedLegacyServiceMap` mapping
  ON CAST(mapping.`serviceId` AS BINARY) = CAST(auth_group.`vendor` AS BINARY)
SET
    auth_group.`service_plugin_id` = mapping.`pluginId`,
    auth_group.`service_local_id` = mapping.`localId`,
    auth_group.`qualified_service_digest` = mapping.`serviceDigest`,
    auth_group.`qualified_group_digest` = SHA2(CONCAT(
        '["group",', JSON_QUOTE(mapping.`pluginId`), ',',
        JSON_QUOTE(mapping.`localId`), ',', JSON_QUOTE(auth_group.`groupId`), ']'
    ), 256),
    auth_group.`active_connected_account_id` = auth_group.`activeProfileId`;

UPDATE `ConnectedServiceAuthGroupMember` member
JOIN `ConnectedServiceAuthGroup` auth_group
  ON CAST(auth_group.`id` AS BINARY) = CAST(member.`groupDbId` AS BINARY)
JOIN `ServiceAccountToken` credential
  ON CAST(credential.`accountId` AS BINARY) = CAST(member.`accountId` AS BINARY)
 AND CAST(credential.`vendor` AS BINARY) = CAST(member.`vendor` AS BINARY)
 AND CAST(credential.`profileId` AS BINARY) = CAST(member.`profileId` AS BINARY)
SET
    member.`credential_id` = credential.`id`,
    member.`qualified_service_digest` = credential.`qualified_service_digest`,
    member.`qualified_group_digest` = auth_group.`qualified_group_digest`,
    member.`qualified_identity_digest` = credential.`qualified_identity_digest`;

UPDATE `ConnectedServiceUsageSource` source
JOIN `ServiceAccountToken` credential
  ON CAST(credential.`accountId` AS BINARY) = CAST(source.`accountId` AS BINARY)
 AND CAST(credential.`vendor` AS BINARY) = CAST(source.`serviceId` AS BINARY)
 AND CAST(credential.`profileId` AS BINARY) = CAST(source.`profileId` AS BINARY)
SET
    source.`service_plugin_id` = credential.`service_plugin_id`,
    source.`service_local_id` = credential.`service_local_id`,
    source.`qualified_service_digest` = credential.`qualified_service_digest`,
    source.`connected_account_id` = credential.`connected_account_id`,
    source.`qualified_identity_digest` = credential.`qualified_identity_digest`,
    source.`credential_id` = credential.`id`;

DROP TEMPORARY TABLE `_QualifiedLegacyServiceMap`;

ALTER TABLE `ServiceAccountToken`
  MODIFY `vendor` VARCHAR(191) NULL, MODIFY `profileId` VARCHAR(191) NULL,
  MODIFY `service_plugin_id` LONGTEXT NOT NULL, MODIFY `service_local_id` LONGTEXT NOT NULL,
  MODIFY `qualified_service_digest` CHAR(64) NOT NULL, MODIFY `connected_account_id` LONGTEXT NOT NULL,
  MODIFY `qualified_identity_digest` CHAR(64) NOT NULL, MODIFY `authentication_mode_id` VARCHAR(191) NOT NULL;
CREATE UNIQUE INDEX `sat_qualified_credential_fkey`
  ON `ServiceAccountToken`(`accountId`,`qualified_service_digest`,`qualified_identity_digest`,`id`);

ALTER TABLE `ConnectedServiceAuthGroup`
  MODIFY `vendor` VARCHAR(191) NULL, MODIFY `service_plugin_id` LONGTEXT NOT NULL,
  MODIFY `service_local_id` LONGTEXT NOT NULL, MODIFY `qualified_service_digest` CHAR(64) NOT NULL,
  MODIFY `qualified_group_digest` CHAR(64) NOT NULL;
CREATE UNIQUE INDEX `csag_qualified_group_fkey`
  ON `ConnectedServiceAuthGroup`(`accountId`,`qualified_service_digest`,`qualified_group_digest`,`id`);

ALTER TABLE `ConnectedServiceAuthGroupMember`
  DROP FOREIGN KEY `ConnectedServiceAuthGroupMember_groupDbId_fkey`,
  DROP FOREIGN KEY `ConnectedServiceAuthGroupMember_accountId_vendor_profileId_fkey`,
  MODIFY `vendor` VARCHAR(191) NULL, MODIFY `groupId` VARCHAR(191) NULL,
  MODIFY `profileId` VARCHAR(191) NULL, MODIFY `credential_id` VARCHAR(191) NOT NULL,
  MODIFY `qualified_service_digest` CHAR(64) NOT NULL, MODIFY `qualified_group_digest` CHAR(64) NOT NULL,
  MODIFY `qualified_identity_digest` CHAR(64) NOT NULL,
  ADD CONSTRAINT `csagm_group_fkey`
    FOREIGN KEY (`accountId`,`qualified_service_digest`,`qualified_group_digest`,`groupDbId`)
    REFERENCES `ConnectedServiceAuthGroup`(`accountId`,`qualified_service_digest`,`qualified_group_digest`,`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `csagm_credential_fkey`
    FOREIGN KEY (`accountId`,`qualified_service_digest`,`qualified_identity_digest`,`credential_id`)
    REFERENCES `ServiceAccountToken`(`accountId`,`qualified_service_digest`,`qualified_identity_digest`,`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX `ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx`
  ON `ConnectedServiceAuthGroupMember`;
CREATE INDEX `ConnectedServiceAuthGroupMember_credential_id_idx`
  ON `ConnectedServiceAuthGroupMember`(`credential_id`);

ALTER TABLE `ConnectedServiceUsageSource`
  MODIFY `serviceId` VARCHAR(191) NULL, MODIFY `profileId` VARCHAR(191) NULL,
  MODIFY `service_plugin_id` LONGTEXT NOT NULL, MODIFY `service_local_id` LONGTEXT NOT NULL,
  MODIFY `qualified_service_digest` CHAR(64) NOT NULL, MODIFY `connected_account_id` LONGTEXT NOT NULL,
  MODIFY `qualified_identity_digest` CHAR(64) NOT NULL, MODIFY `credential_id` VARCHAR(191) NOT NULL,
  ADD CONSTRAINT `csus_credential_fkey`
    FOREIGN KEY (`accountId`,`qualified_service_digest`,`qualified_identity_digest`,`credential_id`)
    REFERENCES `ServiceAccountToken`(`accountId`,`qualified_service_digest`,`qualified_identity_digest`,`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
