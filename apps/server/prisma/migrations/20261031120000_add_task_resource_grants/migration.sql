-- Tasks retain their content in UserKVStore and share through explicit resource grants.

CREATE TABLE "TaskAccountGrant" (
    "taskId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accessLevel" "ShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskAccountGrant_pkey" PRIMARY KEY ("taskId", "accountId")
);

CREATE TABLE "TaskTeamGrant" (
    "taskId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "accessLevel" "ShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskTeamGrant_pkey" PRIMARY KEY ("taskId", "teamId")
);

CREATE TABLE "TaskGroupGrant" (
    "taskId" TEXT NOT NULL,
    "teamGroupId" TEXT NOT NULL,
    "accessLevel" "ShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskGroupGrant_pkey" PRIMARY KEY ("taskId", "teamGroupId")
);

CREATE TABLE "TaskKeyEnvelope" (
    "taskId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "encryptedDataKey" BYTEA NOT NULL,
    "recipientContentPublicKeyFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaskKeyEnvelope_pkey" PRIMARY KEY ("taskId", "recipientAccountId")
);

CREATE INDEX "TaskAccountGrant_accountId_taskId_idx" ON "TaskAccountGrant"("accountId", "taskId");

CREATE INDEX "TaskTeamGrant_teamId_taskId_idx" ON "TaskTeamGrant"("teamId", "taskId");

CREATE INDEX "TaskGroupGrant_teamGroupId_taskId_idx" ON "TaskGroupGrant"("teamGroupId", "taskId");

CREATE INDEX "TaskKeyEnvelope_recipientAccountId_taskId_idx" ON "TaskKeyEnvelope"("recipientAccountId", "taskId");

ALTER TABLE "TaskAccountGrant" ADD CONSTRAINT "TaskAccountGrant_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "UserKVStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAccountGrant" ADD CONSTRAINT "TaskAccountGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskAccountGrant" ADD CONSTRAINT "TaskAccountGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskTeamGrant" ADD CONSTRAINT "TaskTeamGrant_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "UserKVStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskTeamGrant" ADD CONSTRAINT "TaskTeamGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskTeamGrant" ADD CONSTRAINT "TaskTeamGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskGroupGrant" ADD CONSTRAINT "TaskGroupGrant_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "UserKVStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskGroupGrant" ADD CONSTRAINT "TaskGroupGrant_teamGroupId_fkey" FOREIGN KEY ("teamGroupId") REFERENCES "TeamGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskGroupGrant" ADD CONSTRAINT "TaskGroupGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskKeyEnvelope" ADD CONSTRAINT "TaskKeyEnvelope_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "UserKVStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskKeyEnvelope" ADD CONSTRAINT "TaskKeyEnvelope_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
