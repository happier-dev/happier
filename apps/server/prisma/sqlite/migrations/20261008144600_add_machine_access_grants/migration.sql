CREATE TABLE "MachineAccountGrant" (
    "machineId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("machineId", "accountId"),
    CONSTRAINT "MachineAccountGrant_accessLevel_check" CHECK ("accessLevel" IN ('view', 'admin')),
    CONSTRAINT "MachineAccountGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineAccountGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineAccountGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MachineTeamGrant" (
    "machineId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("machineId", "teamId"),
    CONSTRAINT "MachineTeamGrant_accessLevel_check" CHECK ("accessLevel" IN ('view', 'admin')),
    CONSTRAINT "MachineTeamGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineTeamGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineTeamGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MachineGroupGrant" (
    "machineId" TEXT NOT NULL,
    "teamGroupId" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("machineId", "teamGroupId"),
    CONSTRAINT "MachineGroupGrant_accessLevel_check" CHECK ("accessLevel" IN ('view', 'admin')),
    CONSTRAINT "MachineGroupGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineGroupGrant_teamGroupId_fkey" FOREIGN KEY ("teamGroupId") REFERENCES "TeamGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineGroupGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "MachineKeyEnvelope" (
    "machineId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "encryptedDataKey" BLOB NOT NULL,
    "machineOwnerEnvelopeFingerprint" TEXT NOT NULL,
    "recipientContentPublicKeyFingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("machineId", "recipientAccountId"),
    CONSTRAINT "MachineKeyEnvelope_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MachineKeyEnvelope_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MachineAccountGrant_accountId_machineId_idx" ON "MachineAccountGrant"("accountId", "machineId");
CREATE INDEX "MachineTeamGrant_teamId_machineId_idx" ON "MachineTeamGrant"("teamId", "machineId");
CREATE INDEX "MachineGroupGrant_teamGroupId_machineId_idx" ON "MachineGroupGrant"("teamGroupId", "machineId");
CREATE INDEX "MachineKeyEnvelope_recipientAccountId_machineId_idx" ON "MachineKeyEnvelope"("recipientAccountId", "machineId");
