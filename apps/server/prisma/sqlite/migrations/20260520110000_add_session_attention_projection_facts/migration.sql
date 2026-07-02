ALTER TABLE "Session" ADD COLUMN "pendingRequestObservedAt" DATETIME;
ALTER TABLE "Session" ADD COLUMN "latestReadyEventSeq" INTEGER;
ALTER TABLE "Session" ADD COLUMN "latestReadyEventAt" DATETIME;
ALTER TABLE "Session" ADD COLUMN "thinking" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN "thinkingAt" DATETIME;
