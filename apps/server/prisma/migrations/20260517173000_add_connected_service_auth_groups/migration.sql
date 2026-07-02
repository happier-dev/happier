-- Add connected service account group storage and member mappings.

CREATE TABLE "ConnectedServiceAuthGroup" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "displayName" TEXT,
    "policyJson" TEXT NOT NULL,
    "activeProfileId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "stateJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedServiceAuthGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConnectedServiceAuthGroupMember" (
    "id" TEXT NOT NULL,
    "groupDbId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "stateJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedServiceAuthGroupMember_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ConnectedServiceAuthGroup" ADD CONSTRAINT "ConnectedServiceAuthGroup_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConnectedServiceAuthGroupMember" ADD CONSTRAINT "ConnectedServiceAuthGroupMember_groupDbId_fkey"
FOREIGN KEY ("groupDbId") REFERENCES "ConnectedServiceAuthGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ConnectedServiceAuthGroup_accountId_vendor_groupId_key"
ON "ConnectedServiceAuthGroup"("accountId", "vendor", "groupId");

CREATE INDEX "ConnectedServiceAuthGroup_accountId_vendor_idx"
ON "ConnectedServiceAuthGroup"("accountId", "vendor");

CREATE UNIQUE INDEX "ConnectedServiceAuthGroupMember_accountId_vendor_groupId_profileId_key"
ON "ConnectedServiceAuthGroupMember"("accountId", "vendor", "groupId", "profileId");

CREATE INDEX "ConnectedServiceAuthGroupMember_groupDbId_idx"
ON "ConnectedServiceAuthGroupMember"("groupDbId");

CREATE INDEX "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx"
ON "ConnectedServiceAuthGroupMember"("accountId", "vendor", "profileId");
