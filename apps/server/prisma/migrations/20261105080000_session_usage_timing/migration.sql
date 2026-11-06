-- Nullable coverage preserves retained rows and mixed-version clients as unknown.
ALTER TABLE "Session" ADD COLUMN "usageTimingV1" JSONB;
ALTER TABLE "SessionMessage" ADD COLUMN "usageTimingV1" JSONB;
ALTER TABLE "SessionPendingMessage" ADD COLUMN "usageTimingV1" JSONB;
