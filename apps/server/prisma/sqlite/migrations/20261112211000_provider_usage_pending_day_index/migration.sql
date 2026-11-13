DROP INDEX "pauds_day_idx";
CREATE INDEX "pauds_day_idx" ON "ProviderAccountUsageDaySummary" ("dayStartAt", "accountId", "recordId")
WHERE json_extract("payload", '$.coverage.observationCount') > 0;
-- Sweep must contain that same positive-coverage predicate.
