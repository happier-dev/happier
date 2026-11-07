-- Derived accounting state only; UsageEvent and UsageReport remain authoritative.
CREATE TABLE "UsageAccountingProjection" (
    "recordKey" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectHash" TEXT,
    "itemKey" TEXT,
    "sessionId" TEXT,
    "observedAtMs" BIGINT NOT NULL,
    "validFromMs" BIGINT NOT NULL,
    "validUntilMs" BIGINT,
    "ordinal" INTEGER,
    "payload" TEXT NOT NULL,
    CONSTRAINT "UsageAccountingProjection_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UsageAccountingProjection_accountId_kind_observedAtMs_idx" ON "UsageAccountingProjection"("accountId", "kind", "observedAtMs");
CREATE INDEX "UsageAccountingProjection_accountId_kind_subjectHash_idx" ON "UsageAccountingProjection"("accountId", "kind", "subjectHash");
CREATE INDEX "UsageAccountingProjection_accountId_kind_sessionId_idx" ON "UsageAccountingProjection"("accountId", "kind", "sessionId");
CREATE INDEX "UsageAccountingProjection_accountId_kind_itemKey_idx" ON "UsageAccountingProjection"("accountId", "kind", "itemKey");
