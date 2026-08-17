ALTER TABLE "Session" ADD COLUMN "publisherGeneration" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "Session" ADD COLUMN "publisherGenerationLastActiveAt" DATETIME;
