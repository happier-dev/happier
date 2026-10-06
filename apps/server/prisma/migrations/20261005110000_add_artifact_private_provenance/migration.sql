ALTER TABLE "Artifact" ADD COLUMN "provenance" BYTEA;
ALTER TABLE "Artifact" ADD COLUMN "provenanceDataEncryptionKey" BYTEA;
ALTER TABLE "ArtifactRevision" ADD COLUMN "provenance" BYTEA;
ALTER TABLE "ArtifactKeyEnvelope" ADD COLUMN "encryptedProvenanceDataKey" BYTEA;
