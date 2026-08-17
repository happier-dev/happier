ALTER TABLE "Session"
    ADD COLUMN "publisherGeneration" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "publisherGenerationLastActiveAt" TIMESTAMP(3);
