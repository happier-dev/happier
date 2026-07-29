ALTER TABLE "Session"
ADD COLUMN "ownerMetadata" TEXT,
ADD COLUMN "metadataLayoutVersion" INTEGER NOT NULL DEFAULT 0;
