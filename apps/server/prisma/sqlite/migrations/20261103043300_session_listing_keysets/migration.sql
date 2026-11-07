-- FINAL: same publication/keyset indexes and partial predicates as PostgreSQL.
CREATE INDEX "Session_listing_hosted_activity_idx"
ON "Session" ("currentStorageState", "meaningfulActivityAt" DESC, "id" DESC);

CREATE INDEX "Session_listing_state_snapshot_idx"
ON "Session" ("currentStorageState", "materializedThroughSourceAt" DESC, "id" DESC);

CREATE INDEX "Session_listing_hosted_created_idx"
ON "Session" ("createdAt" DESC, "id" DESC)
WHERE "currentStorageState" = 'hosted' AND "meaningfulActivityAt" IS NULL;

CREATE INDEX "Session_listing_incomplete_created_idx"
ON "Session" ("createdAt" DESC, "id" DESC)
WHERE "currentStorageState" <> 'hosted' AND NOT (
    "currentStorageState" = 'snapshot_complete' AND "materializationPublicationId" <> ''
    AND "materializedThroughSourceAt" >= 0 AND "materializedThroughSourceAt" <= 9007199254740991
    AND "publishedThroughServerSeq" >= 0 AND "publishedThroughServerSeq" <= "seq"
);
