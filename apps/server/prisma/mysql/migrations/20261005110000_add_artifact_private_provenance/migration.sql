ALTER TABLE `Artifact` ADD COLUMN `provenance` LONGBLOB NULL;
ALTER TABLE `Artifact` ADD COLUMN `provenanceDataEncryptionKey` LONGBLOB NULL;
ALTER TABLE `ArtifactRevision` ADD COLUMN `provenance` LONGBLOB NULL;
ALTER TABLE `ArtifactKeyEnvelope` ADD COLUMN `encryptedProvenanceDataKey` LONGBLOB NULL;
