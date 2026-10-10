CREATE TABLE "ProviderAccountUsageHistory" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    CONSTRAINT "ProviderAccountUsageHistory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderAccountUsageHistory_accountId_recordId_fkey" FOREIGN KEY ("accountId", "recordId") REFERENCES "ProviderAccountUsageRecord"("accountId", "recordId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "pauh_record_time_idx" ON "ProviderAccountUsageHistory"("accountId", "recordId", "observedAt", "id");
