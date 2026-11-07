-- Tasks retain their content in UserKVStore and share through explicit resource grants.

CREATE TABLE "TaskAccountGrant" (
    "taskId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("taskId", "accountId"),
    CONSTRAINT "TaskAccountGrant_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "UserKVStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskAccountGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskAccountGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TaskTeamGrant" (
    "taskId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("taskId", "teamId"),
    CONSTRAINT "TaskTeamGrant_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "UserKVStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskTeamGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskTeamGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TaskGroupGrant" (
    "taskId" TEXT NOT NULL,
    "teamGroupId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("taskId", "teamGroupId"),
    CONSTRAINT "TaskGroupGrant_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "UserKVStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskGroupGrant_teamGroupId_fkey" FOREIGN KEY ("teamGroupId") REFERENCES "TeamGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskGroupGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TaskKeyEnvelope" (
    "taskId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "encryptedDataKey" BLOB NOT NULL,
    "recipientContentPublicKeyFingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("taskId", "recipientAccountId"),
    CONSTRAINT "TaskKeyEnvelope_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "UserKVStore" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskKeyEnvelope_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "TaskAccountGrant_accountId_taskId_idx" ON "TaskAccountGrant"("accountId", "taskId");

CREATE INDEX "TaskTeamGrant_teamId_taskId_idx" ON "TaskTeamGrant"("teamId", "taskId");

CREATE INDEX "TaskGroupGrant_teamGroupId_taskId_idx" ON "TaskGroupGrant"("teamGroupId", "taskId");

CREATE INDEX "TaskKeyEnvelope_recipientAccountId_taskId_idx" ON "TaskKeyEnvelope"("recipientAccountId", "taskId");
