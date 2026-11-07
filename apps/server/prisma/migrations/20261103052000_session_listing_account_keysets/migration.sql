-- FINAL: replace global listing keys with Account-ordered keys after the
-- compiled scope is split into owned/other keyset reads. The earlier applied
-- 20261103043300 migration is immutable. All four replacements are EXPLAIN-proven.
DROP INDEX "Session_listing_hosted_activity_idx";
DROP INDEX "Session_listing_state_snapshot_idx";
DROP INDEX "Session_listing_hosted_created_idx";
DROP INDEX "Session_listing_incomplete_created_idx";

CREATE INDEX "Session_listing_hosted_activity_idx"
ON "Session" ("accountId", "currentStorageState", "meaningfulActivityAt" DESC, "id" DESC);

CREATE INDEX "Session_listing_state_snapshot_idx"
ON "Session" ("accountId", "currentStorageState", "materializedThroughSourceAt" DESC, "id" DESC);

CREATE INDEX "Session_listing_hosted_created_idx"
ON "Session" ("accountId", "createdAt" DESC, "id" DESC)
WHERE "currentStorageState" = 'hosted' AND "meaningfulActivityAt" IS NULL;

CREATE INDEX "Session_listing_incomplete_created_idx"
ON "Session" ("accountId", "createdAt" DESC, "id" DESC)
WHERE "currentStorageState" <> 'hosted' AND NOT (
    "currentStorageState" = 'snapshot_complete' AND "materializationPublicationId" <> ''
    AND "materializedThroughSourceAt" >= 0 AND "materializedThroughSourceAt" <= 9007199254740991
    AND "publishedThroughServerSeq" >= 0 AND "publishedThroughServerSeq" <= "seq"
);
