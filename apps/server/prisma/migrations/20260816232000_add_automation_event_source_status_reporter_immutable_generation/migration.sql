-- Source status is authored by one host-stamped immutable contributor
-- generation. Retained rows predate this provenance and intentionally remain
-- NULL/fail closed for recovery authority.
ALTER TABLE "AutomationEventSourceStatus"
ADD COLUMN "reporterImmutableGenerationId" VARCHAR(256);
