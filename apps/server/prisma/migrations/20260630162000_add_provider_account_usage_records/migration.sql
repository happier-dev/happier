-- Add dedicated provider-account usage records and connected-service usage sources.

CREATE TABLE "ProviderAccountUsageRecord" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "accountSubjectId" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "quotaScope" TEXT NOT NULL,
    "quotaScopeId" TEXT,
    "quotaScopeIdKey" TEXT NOT NULL,
    "recordKeyJson" JSONB NOT NULL,
    "payloadMode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "snapshot" JSONB,
    "sealedPayload" JSONB,
    "fetchedAt" TIMESTAMP(3),
    "staleAfterMs" INTEGER,
    "refreshRequestedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderAccountUsageRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectedServiceUsageSource" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "providerAccountUsageRecordId" TEXT NOT NULL,
    "bindingKind" TEXT NOT NULL,
    "groupId" TEXT,
    "groupGeneration" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedServiceUsageSource_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProviderAccountUsageRecord"
ADD CONSTRAINT "ProviderAccountUsageRecord_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProviderAccountUsageRecord_accountId_recordId_key"
ON "ProviderAccountUsageRecord"("accountId", "recordId");

ALTER TABLE "ConnectedServiceUsageSource"
ADD CONSTRAINT "csus_paur_fkey"
FOREIGN KEY ("accountId", "providerAccountUsageRecordId") REFERENCES "ProviderAccountUsageRecord"("accountId", "recordId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "paur_identity_key"
ON "ProviderAccountUsageRecord"("accountId", "providerId", "accountSubjectId", "quotaScope", "quotaScopeIdKey");

CREATE INDEX "ProviderAccountUsageRecord_accountId_providerId_idx"
ON "ProviderAccountUsageRecord"("accountId", "providerId");

CREATE INDEX "ProviderAccountUsageRecord_accountId_status_idx"
ON "ProviderAccountUsageRecord"("accountId", "status");

CREATE INDEX "csus_account_service_profile_idx"
ON "ConnectedServiceUsageSource"("accountId", "serviceId", "profileId");

CREATE UNIQUE INDEX "ConnectedServiceUsageSource_accountId_sourceKey_key"
ON "ConnectedServiceUsageSource"("accountId", "sourceKey");

CREATE INDEX "csus_paur_idx"
ON "ConnectedServiceUsageSource"("accountId", "providerAccountUsageRecordId");
