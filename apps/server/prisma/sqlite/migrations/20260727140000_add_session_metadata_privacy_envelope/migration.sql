ALTER TABLE "Session" ADD COLUMN "ownerMetadata" TEXT;
ALTER TABLE "Session" ADD COLUMN "metadataLayoutVersion" INTEGER NOT NULL DEFAULT 0;
