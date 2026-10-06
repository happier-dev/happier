ALTER TABLE "Artifact" ADD COLUMN "provenance" BLOB;
ALTER TABLE "Artifact" ADD COLUMN "provenanceDataEncryptionKey" BLOB;
ALTER TABLE "ArtifactRevision" ADD COLUMN "provenance" BLOB;
ALTER TABLE "ArtifactKeyEnvelope" ADD COLUMN "encryptedProvenanceDataKey" BLOB;
