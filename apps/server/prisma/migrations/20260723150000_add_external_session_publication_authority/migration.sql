ALTER TABLE "Session"
    ADD COLUMN "currentStorageState" TEXT NOT NULL DEFAULT 'hosted',
    ADD COLUMN "acceptedThroughServerSeq" INTEGER,
    ADD COLUMN "materializationPublicationId" TEXT,
    ADD COLUMN "materializedThroughSourceAt" BIGINT,
    ADD COLUMN "publishedThroughServerSeq" INTEGER;

-- Predecessor direct External Session rows were created before any
-- server-readable publication authority existed, so nothing proves their
-- server transcript is the complete conversation. Inheriting the `hosted`
-- default would make them unbounded and shareable. They fail closed at
-- `legacy_external_unknown` until the owner machine reconciles them; the
-- message count is deliberately not consulted, because a partial import is
-- exactly the row that looks non-empty. Ordinary Sessions keep `hosted`.
UPDATE "Session"
SET "currentStorageState" = 'legacy_external_unknown'
WHERE "tag" COLLATE "C" LIKE 'direct:v1:%';
