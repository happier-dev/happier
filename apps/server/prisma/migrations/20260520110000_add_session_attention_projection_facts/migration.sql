ALTER TABLE "Session" ADD COLUMN "pendingRequestObservedAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "latestReadyEventSeq" INTEGER;
ALTER TABLE "Session" ADD COLUMN "latestReadyEventAt" TIMESTAMP(3);
ALTER TABLE "Session" ADD COLUMN "thinking" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Session" ADD COLUMN "thinkingAt" TIMESTAMP(3);
