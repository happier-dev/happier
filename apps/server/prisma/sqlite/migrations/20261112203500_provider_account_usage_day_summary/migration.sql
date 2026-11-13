CREATE TABLE "ProviderAccountUsageDaySummary" (
    "accountId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "dayStartAt" DATETIME NOT NULL,
    "payload" JSONB NOT NULL,
    CONSTRAINT "ProviderAccountUsageDaySummary_pkey" PRIMARY KEY ("accountId", "recordId", "dayStartAt"),
    CONSTRAINT "ProviderAccountUsageDaySummary_accountId_recordId_fkey" FOREIGN KEY ("accountId", "recordId") REFERENCES "ProviderAccountUsageRecord"("accountId", "recordId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "pauds_day_idx" ON "ProviderAccountUsageDaySummary"("dayStartAt", "accountId", "recordId");
