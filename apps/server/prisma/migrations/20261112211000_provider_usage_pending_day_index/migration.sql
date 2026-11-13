-- This replaces the retention-only full day index; per-record reads use the PK.
DROP INDEX "pauds_day_idx";
CREATE INDEX "pauds_day_idx" ON "ProviderAccountUsageDaySummary" ("dayStartAt", "accountId", "recordId")
WHERE CAST("payload" #>> '{coverage,observationCount}' AS BIGINT) > 0;
-- Sweep must contain that same positive-coverage predicate.
