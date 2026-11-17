ALTER TABLE `Team` ADD COLUMN `reviewCreationPolicy` ENUM('private_default', 'team_default', 'team_required') NOT NULL DEFAULT 'private_default';
ALTER TABLE `ArtifactGrant` ADD COLUMN `requiredByTeamPolicy` BOOLEAN NOT NULL DEFAULT false;
