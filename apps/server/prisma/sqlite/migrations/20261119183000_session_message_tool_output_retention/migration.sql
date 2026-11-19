ALTER TABLE "SessionMessage" ADD COLUMN "toolOutputBytes" BLOB;
ALTER TABLE "SessionMessage" ADD COLUMN "toolOutputExpiredAfterDays" INTEGER;
