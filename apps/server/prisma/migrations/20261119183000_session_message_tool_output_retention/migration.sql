ALTER TABLE "SessionMessage" ADD COLUMN "toolOutputBytes" BYTEA;
ALTER TABLE "SessionMessage" ADD COLUMN "toolOutputExpiredAfterDays" INTEGER;
