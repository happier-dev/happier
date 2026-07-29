ALTER TABLE "Session" ADD COLUMN "currentStorageState" TEXT NOT NULL DEFAULT 'hosted';
ALTER TABLE "Session" ADD COLUMN "acceptedThroughServerSeq" INTEGER;
ALTER TABLE "Session" ADD COLUMN "materializationPublicationId" TEXT;
ALTER TABLE "Session" ADD COLUMN "materializedThroughSourceAt" BIGINT;
ALTER TABLE "Session" ADD COLUMN "publishedThroughServerSeq" INTEGER;
