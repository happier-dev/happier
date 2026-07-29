-- CreateTable
CREATE TABLE "AccountLiveActivityTarget" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "activityInstanceKey" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "activityName" TEXT NOT NULL,
    "targetIdentityHash" TEXT NOT NULL,
    "transportMode" TEXT NOT NULL,
    "bundleId" TEXT,
    "environment" TEXT,
    "tokenKind" TEXT NOT NULL,
    "rawTokenEncrypted" BYTEA,
    "expoPushToken" TEXT,
    "clientServerUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "lastPushedAt" TIMESTAMP(3),
    "lastPayloadHash" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureCode" TEXT,
    "diagnostics" JSONB,

    CONSTRAINT "AccountLiveActivityTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountLiveActivityTarget_accountId_targetIdentityHash_key" ON "AccountLiveActivityTarget"("accountId", "targetIdentityHash");

-- CreateIndex
CREATE INDEX "AccountLiveActivityTarget_lookup_active_idx" ON "AccountLiveActivityTarget"("accountId", "serverId", "sessionId", "activityName", "endedAt");

-- CreateIndex
CREATE INDEX "AccountLiveActivityTarget_accountId_transportMode_endedAt_idx" ON "AccountLiveActivityTarget"("accountId", "transportMode", "endedAt");

-- AddForeignKey
ALTER TABLE "AccountLiveActivityTarget" ADD CONSTRAINT "AccountLiveActivityTarget_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
