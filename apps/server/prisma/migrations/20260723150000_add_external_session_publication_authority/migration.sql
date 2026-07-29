ALTER TABLE "Session"
    ADD COLUMN "currentStorageState" TEXT NOT NULL DEFAULT 'hosted',
    ADD COLUMN "acceptedThroughServerSeq" INTEGER,
    ADD COLUMN "materializationPublicationId" TEXT,
    ADD COLUMN "materializedThroughSourceAt" BIGINT,
    ADD COLUMN "publishedThroughServerSeq" INTEGER;
