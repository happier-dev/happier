-- Consolidate Machine principal arms; content and recipient envelopes remain owned by their existing tables.
CREATE TABLE `MachineGrant` (
    `id` VARCHAR(191) NOT NULL PRIMARY KEY,
    `machineId` VARCHAR(191) NOT NULL,
    `principalKind` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191),
    `teamId` VARCHAR(191),
    `teamGroupId` VARCHAR(191),
    `accessLevel` ENUM('view','admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `MachineGrant_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `MachineGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `MachineGrant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `MachineGrant_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `MachineGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- MySQL CHECK cannot reference cascading FK columns (error3823).
-- Match the existing PublicSessionShare provider invariant with explicit errors.
CREATE TRIGGER `MachineGrant_principal_insert`
BEFORE INSERT ON `MachineGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MachineGrant selected principal arm is invalid';
    END IF;
END;

CREATE TRIGGER `MachineGrant_principal_update`
BEFORE UPDATE ON `MachineGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'MachineGrant selected principal arm is invalid';
    END IF;
END;

INSERT INTO `MachineGrant` (`id`, `machineId`, `principalKind`, `accountId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `machineId`, 'account', `accountId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `MachineAccountGrant`;
INSERT INTO `MachineGrant` (`id`, `machineId`, `principalKind`, `teamId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `machineId`, 'team', `teamId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `MachineTeamGrant`;
INSERT INTO `MachineGrant` (`id`, `machineId`, `principalKind`, `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `machineId`, 'group', `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `MachineGroupGrant`;
CREATE UNIQUE INDEX `MachineGrant_machineId_accountId_key` ON `MachineGrant`(`machineId`, `accountId`);
CREATE INDEX `MachineGrant_accountId_machineId_idx` ON `MachineGrant`(`accountId`, `machineId`);
CREATE UNIQUE INDEX `MachineGrant_machineId_teamId_key` ON `MachineGrant`(`machineId`, `teamId`);
CREATE INDEX `MachineGrant_teamId_machineId_idx` ON `MachineGrant`(`teamId`, `machineId`);
CREATE UNIQUE INDEX `MachineGrant_machineId_teamGroupId_key` ON `MachineGrant`(`machineId`, `teamGroupId`);
CREATE INDEX `MachineGrant_teamGroupId_machineId_idx` ON `MachineGrant`(`teamGroupId`, `machineId`);
CREATE INDEX `MachineGrant_createdByAccountId_idx` ON `MachineGrant`(`createdByAccountId`);
DROP TABLE `MachineAccountGrant`;
DROP TABLE `MachineTeamGrant`;
DROP TABLE `MachineGroupGrant`;

-- Consolidate Artifact principal arms; content and recipient envelopes remain owned by their existing tables.
CREATE TABLE `ArtifactGrant` (
    `id` VARCHAR(191) NOT NULL PRIMARY KEY,
    `artifactId` VARCHAR(191) NOT NULL,
    `principalKind` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191),
    `teamId` VARCHAR(191),
    `teamGroupId` VARCHAR(191),
    `accessLevel` ENUM('view','edit','admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `ArtifactGrant_artifactId_fkey` FOREIGN KEY (`artifactId`) REFERENCES `Artifact` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ArtifactGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ArtifactGrant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ArtifactGrant_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `ArtifactGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- MySQL CHECK cannot reference cascading FK columns (error3823).
-- Match the existing PublicSessionShare provider invariant with explicit errors.
CREATE TRIGGER `ArtifactGrant_principal_insert`
BEFORE INSERT ON `ArtifactGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ArtifactGrant selected principal arm is invalid';
    END IF;
END;

CREATE TRIGGER `ArtifactGrant_principal_update`
BEFORE UPDATE ON `ArtifactGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ArtifactGrant selected principal arm is invalid';
    END IF;
END;

INSERT INTO `ArtifactGrant` (`id`, `artifactId`, `principalKind`, `accountId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `artifactId`, 'account', `accountId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `ArtifactAccountGrant`;
INSERT INTO `ArtifactGrant` (`id`, `artifactId`, `principalKind`, `teamId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `artifactId`, 'team', `teamId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `ArtifactTeamGrant`;
INSERT INTO `ArtifactGrant` (`id`, `artifactId`, `principalKind`, `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `artifactId`, 'group', `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `ArtifactGroupGrant`;
CREATE UNIQUE INDEX `ArtifactGrant_artifactId_accountId_key` ON `ArtifactGrant`(`artifactId`, `accountId`);
CREATE INDEX `ArtifactGrant_accountId_artifactId_idx` ON `ArtifactGrant`(`accountId`, `artifactId`);
CREATE UNIQUE INDEX `ArtifactGrant_artifactId_teamId_key` ON `ArtifactGrant`(`artifactId`, `teamId`);
CREATE INDEX `ArtifactGrant_teamId_artifactId_idx` ON `ArtifactGrant`(`teamId`, `artifactId`);
CREATE UNIQUE INDEX `ArtifactGrant_artifactId_teamGroupId_key` ON `ArtifactGrant`(`artifactId`, `teamGroupId`);
CREATE INDEX `ArtifactGrant_teamGroupId_artifactId_idx` ON `ArtifactGrant`(`teamGroupId`, `artifactId`);
CREATE INDEX `ArtifactGrant_createdByAccountId_idx` ON `ArtifactGrant`(`createdByAccountId`);
DROP TABLE `ArtifactAccountGrant`;
DROP TABLE `ArtifactTeamGrant`;
DROP TABLE `ArtifactGroupGrant`;

-- Consolidate Task principal arms; content and recipient envelopes remain owned by their existing tables.
CREATE TABLE `TaskGrant` (
    `id` VARCHAR(191) NOT NULL PRIMARY KEY,
    `taskId` VARCHAR(191) NOT NULL,
    `principalKind` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191),
    `teamId` VARCHAR(191),
    `teamGroupId` VARCHAR(191),
    `accessLevel` ENUM('view','edit','admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `TaskGrant_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `UserKVStore` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `TaskGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `TaskGrant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `TaskGrant_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `TaskGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- MySQL CHECK cannot reference cascading FK columns (error3823).
-- Match the existing PublicSessionShare provider invariant with explicit errors.
CREATE TRIGGER `TaskGrant_principal_insert`
BEFORE INSERT ON `TaskGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TaskGrant selected principal arm is invalid';
    END IF;
END;

CREATE TRIGGER `TaskGrant_principal_update`
BEFORE UPDATE ON `TaskGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'TaskGrant selected principal arm is invalid';
    END IF;
END;

INSERT INTO `TaskGrant` (`id`, `taskId`, `principalKind`, `accountId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `taskId`, 'account', `accountId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `TaskAccountGrant`;
INSERT INTO `TaskGrant` (`id`, `taskId`, `principalKind`, `teamId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `taskId`, 'team', `teamId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `TaskTeamGrant`;
INSERT INTO `TaskGrant` (`id`, `taskId`, `principalKind`, `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `taskId`, 'group', `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `TaskGroupGrant`;
CREATE UNIQUE INDEX `TaskGrant_taskId_accountId_key` ON `TaskGrant`(`taskId`, `accountId`);
CREATE INDEX `TaskGrant_accountId_taskId_idx` ON `TaskGrant`(`accountId`, `taskId`);
CREATE UNIQUE INDEX `TaskGrant_taskId_teamId_key` ON `TaskGrant`(`taskId`, `teamId`);
CREATE INDEX `TaskGrant_teamId_taskId_idx` ON `TaskGrant`(`teamId`, `taskId`);
CREATE UNIQUE INDEX `TaskGrant_taskId_teamGroupId_key` ON `TaskGrant`(`taskId`, `teamGroupId`);
CREATE INDEX `TaskGrant_teamGroupId_taskId_idx` ON `TaskGrant`(`teamGroupId`, `taskId`);
CREATE INDEX `TaskGrant_createdByAccountId_idx` ON `TaskGrant`(`createdByAccountId`);
DROP TABLE `TaskAccountGrant`;
DROP TABLE `TaskTeamGrant`;
DROP TABLE `TaskGroupGrant`;

-- Consolidate PluginCollection principal arms; content and recipient envelopes remain owned by their existing tables.
CREATE TABLE `PluginCollectionGrant` (
    `id` VARCHAR(191) NOT NULL PRIMARY KEY,
    `rowDbId` VARCHAR(25) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `principalKind` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191),
    `teamId` VARCHAR(191),
    `teamGroupId` VARCHAR(191),
    `accessLevel` ENUM('view','edit','admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `PluginCollectionGrant_rowDbId_fkey` FOREIGN KEY (`rowDbId`) REFERENCES `PluginCollectionRow` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionGrant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionGrant_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `PluginCollectionGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- MySQL CHECK cannot reference cascading FK columns (error3823).
-- Match the existing PublicSessionShare provider invariant with explicit errors.
CREATE TRIGGER `PluginCollectionGrant_principal_insert`
BEFORE INSERT ON `PluginCollectionGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PluginCollectionGrant selected principal arm is invalid';
    END IF;
END;

CREATE TRIGGER `PluginCollectionGrant_principal_update`
BEFORE UPDATE ON `PluginCollectionGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PluginCollectionGrant selected principal arm is invalid';
    END IF;
END;

INSERT INTO `PluginCollectionGrant` (`id`, `rowDbId`, `principalKind`, `accountId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `rowDbId`, 'account', `accountId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `PluginCollectionAccountGrant`;
INSERT INTO `PluginCollectionGrant` (`id`, `rowDbId`, `principalKind`, `teamId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `rowDbId`, 'team', `teamId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `PluginCollectionTeamGrant`;
INSERT INTO `PluginCollectionGrant` (`id`, `rowDbId`, `principalKind`, `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `rowDbId`, 'group', `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `PluginCollectionGroupGrant`;
CREATE UNIQUE INDEX `PluginCollectionGrant_rowDbId_accountId_key` ON `PluginCollectionGrant`(`rowDbId`, `accountId`);
CREATE INDEX `PluginCollectionGrant_accountId_rowDbId_idx` ON `PluginCollectionGrant`(`accountId`, `rowDbId`);
CREATE UNIQUE INDEX `PluginCollectionGrant_rowDbId_teamId_key` ON `PluginCollectionGrant`(`rowDbId`, `teamId`);
CREATE INDEX `PluginCollectionGrant_teamId_rowDbId_idx` ON `PluginCollectionGrant`(`teamId`, `rowDbId`);
CREATE UNIQUE INDEX `PluginCollectionGrant_rowDbId_teamGroupId_key` ON `PluginCollectionGrant`(`rowDbId`, `teamGroupId`);
CREATE INDEX `PluginCollectionGrant_teamGroupId_rowDbId_idx` ON `PluginCollectionGrant`(`teamGroupId`, `rowDbId`);
CREATE INDEX `PluginCollectionGrant_createdByAccountId_idx` ON `PluginCollectionGrant`(`createdByAccountId`);
DROP TABLE `PluginCollectionAccountGrant`;
DROP TABLE `PluginCollectionTeamGrant`;
DROP TABLE `PluginCollectionGroupGrant`;

-- Consolidate Discussion principal arms; content and recipient envelopes remain owned by their existing tables.
CREATE TABLE `DiscussionGrant` (
    `id` VARCHAR(191) NOT NULL PRIMARY KEY,
    `discussionId` VARCHAR(191) NOT NULL,
    `principalKind` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191),
    `teamId` VARCHAR(191),
    `teamGroupId` VARCHAR(191),
    `accessLevel` ENUM('view','edit','admin') NOT NULL,
    `createdByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `DiscussionGrant_discussionId_fkey` FOREIGN KEY (`discussionId`) REFERENCES `Discussion` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `DiscussionGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `DiscussionGrant_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `DiscussionGrant_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `DiscussionGrant_createdByAccountId_fkey` FOREIGN KEY (`createdByAccountId`) REFERENCES `Account` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- MySQL CHECK cannot reference cascading FK columns (error3823).
-- Match the existing PublicSessionShare provider invariant with explicit errors.
CREATE TRIGGER `DiscussionGrant_principal_insert`
BEFORE INSERT ON `DiscussionGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DiscussionGrant selected principal arm is invalid';
    END IF;
END;

CREATE TRIGGER `DiscussionGrant_principal_update`
BEFORE UPDATE ON `DiscussionGrant`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`accountId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'team' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL) OR (NEW.`principalKind` = 'group' AND NEW.`accountId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'DiscussionGrant selected principal arm is invalid';
    END IF;
END;

INSERT INTO `DiscussionGrant` (`id`, `discussionId`, `principalKind`, `accountId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `discussionId`, 'account', `accountId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `DiscussionAccountGrant`;
INSERT INTO `DiscussionGrant` (`id`, `discussionId`, `principalKind`, `teamId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `discussionId`, 'team', `teamId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `DiscussionTeamGrant`;
INSERT INTO `DiscussionGrant` (`id`, `discussionId`, `principalKind`, `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt`)
SELECT UUID(), `discussionId`, 'group', `teamGroupId`, `accessLevel`, `createdByAccountId`, `createdAt` FROM `DiscussionGroupGrant`;
CREATE UNIQUE INDEX `DiscussionGrant_discussionId_accountId_key` ON `DiscussionGrant`(`discussionId`, `accountId`);
CREATE INDEX `DiscussionGrant_accountId_discussionId_idx` ON `DiscussionGrant`(`accountId`, `discussionId`);
CREATE UNIQUE INDEX `DiscussionGrant_discussionId_teamId_key` ON `DiscussionGrant`(`discussionId`, `teamId`);
CREATE INDEX `DiscussionGrant_teamId_discussionId_idx` ON `DiscussionGrant`(`teamId`, `discussionId`);
CREATE UNIQUE INDEX `DiscussionGrant_discussionId_teamGroupId_key` ON `DiscussionGrant`(`discussionId`, `teamGroupId`);
CREATE INDEX `DiscussionGrant_teamGroupId_discussionId_idx` ON `DiscussionGrant`(`teamGroupId`, `discussionId`);
CREATE INDEX `DiscussionGrant_createdByAccountId_idx` ON `DiscussionGrant`(`createdByAccountId`);
DROP TABLE `DiscussionAccountGrant`;
DROP TABLE `DiscussionTeamGrant`;
DROP TABLE `DiscussionGroupGrant`;

ALTER TABLE `SessionShare`
 MODIFY `sharedWithUserId` VARCHAR(191) NULL,
 MODIFY `sharedByUserId` VARCHAR(191) NULL,
 ADD COLUMN `principalKind` VARCHAR(191) NOT NULL DEFAULT 'account',
 ADD COLUMN `teamId` VARCHAR(191) NULL,
 ADD COLUMN `teamGroupId` VARCHAR(191) NULL,
 ADD COLUMN `requiredByTeamPolicy` BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN `effectiveAt` DATETIME(3) NULL;
ALTER TABLE `SessionShare` ADD CONSTRAINT `SessionShare_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SessionShare` ADD CONSTRAINT `SessionShare_teamGroupId_fkey` FOREIGN KEY (`teamGroupId`) REFERENCES `TeamGroup` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SessionShare` ALTER COLUMN `principalKind` DROP DEFAULT;
-- MySQL CHECK cannot reference cascading FK columns (error3823).
-- Match the existing PublicSessionShare provider invariant with explicit errors.
CREATE TRIGGER `SessionShare_principal_insert`
BEFORE INSERT ON `SessionShare`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`sharedWithUserId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL AND NEW.`effectiveAt` IS NULL AND NEW.`sharedByUserId` IS NOT NULL AND NEW.`requiredByTeamPolicy` = false) OR (NEW.`principalKind` = 'team' AND NEW.`sharedWithUserId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL AND NEW.`effectiveAt` IS NOT NULL) OR (NEW.`principalKind` = 'group' AND NEW.`sharedWithUserId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL AND NEW.`effectiveAt` IS NOT NULL AND NEW.`requiredByTeamPolicy` = false)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionShare selected principal arm is invalid';
    END IF;
END;

CREATE TRIGGER `SessionShare_principal_update`
BEFORE UPDATE ON `SessionShare`
FOR EACH ROW
BEGIN
    IF NOT ((NEW.`principalKind` = 'account' AND NEW.`sharedWithUserId` IS NOT NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NULL AND NEW.`effectiveAt` IS NULL AND NEW.`sharedByUserId` IS NOT NULL AND NEW.`requiredByTeamPolicy` = false) OR (NEW.`principalKind` = 'team' AND NEW.`sharedWithUserId` IS NULL AND NEW.`teamId` IS NOT NULL AND NEW.`teamGroupId` IS NULL AND NEW.`effectiveAt` IS NOT NULL) OR (NEW.`principalKind` = 'group' AND NEW.`sharedWithUserId` IS NULL AND NEW.`teamId` IS NULL AND NEW.`teamGroupId` IS NOT NULL AND NEW.`effectiveAt` IS NOT NULL AND NEW.`requiredByTeamPolicy` = false)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionShare selected principal arm is invalid';
    END IF;
END;

INSERT INTO `SessionShare` (`id`,`sessionId`,`principalKind`,`teamId`,`accessLevel`,`canApprovePermissions`,`requiredByTeamPolicy`,`effectiveAt`,`createdAt`,`updatedAt`)
SELECT UUID(),`sessionId`,'team',`teamId`,`accessLevel`,`canApprovePermissions`,`requiredByTeamPolicy`,`effectiveAt`,`effectiveAt`,`effectiveAt` FROM `SessionTeamGrant`;
INSERT INTO `SessionShare` (`id`,`sessionId`,`principalKind`,`teamGroupId`,`accessLevel`,`canApprovePermissions`,`requiredByTeamPolicy`,`effectiveAt`,`createdAt`,`updatedAt`)
SELECT UUID(),`sessionId`,'group',`teamGroupId`,`accessLevel`,`canApprovePermissions`,false,`effectiveAt`,`effectiveAt`,`effectiveAt` FROM `SessionGroupGrant`;
CREATE INDEX `SessionShare_sharedWithUserId_sessionId_idx` ON `SessionShare` (`sharedWithUserId`,`sessionId`);
CREATE UNIQUE INDEX `SessionShare_sessionId_teamId_key` ON `SessionShare` (`sessionId`,`teamId`);
CREATE INDEX `SessionShare_teamId_sessionId_idx` ON `SessionShare` (`teamId`,`sessionId`);
CREATE UNIQUE INDEX `SessionShare_sessionId_teamGroupId_key` ON `SessionShare` (`sessionId`,`teamGroupId`);
CREATE INDEX `SessionShare_teamGroupId_sessionId_idx` ON `SessionShare` (`teamGroupId`,`sessionId`);
DROP INDEX `SessionShare_sharedWithUserId_idx` ON `SessionShare`;
DROP TABLE `SessionTeamGrant`;
DROP TABLE `SessionGroupGrant`;
