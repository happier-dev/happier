ALTER TABLE "SessionSystemRecord"
ADD COLUMN "ownerKind" TEXT,
ADD COLUMN "pluginId" TEXT,
ADD COLUMN "namespaceAddressKey" BYTEA,
ADD COLUMN "recordAddressKey" BYTEA,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "SessionSystemRecord"
ADD CONSTRAINT "SessionSystemRecord_ownerKind_check"
CHECK ("ownerKind" IS NULL OR "ownerKind" IN ('host', 'plugin'));

ALTER TABLE "SessionSystemRecord"
ADD CONSTRAINT "SessionSystemRecord_version_check"
CHECK ("version" BETWEEN 1 AND 2147483647);
