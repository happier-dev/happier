-- CreateTable
CREATE TABLE "AccountLiveActivityTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "rawTokenEncrypted" BLOB,
    "expoPushToken" TEXT,
    "clientServerUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "lastPushedAt" DATETIME,
    "lastPayloadHash" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureCode" TEXT,
    "diagnostics" JSONB,
    CONSTRAINT "AccountLiveActivityTarget_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountLiveActivityTarget_accountId_targetIdentityHash_key" ON "AccountLiveActivityTarget"("accountId", "targetIdentityHash");

-- CreateIndex
CREATE INDEX "AccountLiveActivityTarget_lookup_active_idx" ON "AccountLiveActivityTarget"("accountId", "serverId", "sessionId", "activityName", "endedAt");

-- CreateIndex
CREATE INDEX "AccountLiveActivityTarget_accountId_transportMode_endedAt_idx" ON "AccountLiveActivityTarget"("accountId", "transportMode", "endedAt");
