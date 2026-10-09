CREATE TYPE "MachineShareAccessLevel" AS ENUM ('view', 'admin');

CREATE TABLE "MachineAccountGrant" (
    "machineId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accessLevel" "MachineShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MachineAccountGrant_pkey" PRIMARY KEY ("machineId", "accountId"),
    CONSTRAINT "MachineAccountGrant_accessLevel_check" CHECK ("accessLevel" IN ('view', 'admin'))
);

CREATE TABLE "MachineTeamGrant" (
    "machineId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "accessLevel" "MachineShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MachineTeamGrant_pkey" PRIMARY KEY ("machineId", "teamId"),
    CONSTRAINT "MachineTeamGrant_accessLevel_check" CHECK ("accessLevel" IN ('view', 'admin'))
);

CREATE TABLE "MachineGroupGrant" (
    "machineId" TEXT NOT NULL,
    "teamGroupId" TEXT NOT NULL,
    "accessLevel" "MachineShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MachineGroupGrant_pkey" PRIMARY KEY ("machineId", "teamGroupId"),
    CONSTRAINT "MachineGroupGrant_accessLevel_check" CHECK ("accessLevel" IN ('view', 'admin'))
);

CREATE TABLE "MachineKeyEnvelope" (
    "machineId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "encryptedDataKey" BYTEA NOT NULL,
    "machineOwnerEnvelopeFingerprint" TEXT NOT NULL,
    "recipientContentPublicKeyFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MachineKeyEnvelope_pkey" PRIMARY KEY ("machineId", "recipientAccountId")
);

CREATE INDEX "MachineAccountGrant_accountId_machineId_idx" ON "MachineAccountGrant"("accountId", "machineId");
CREATE INDEX "MachineTeamGrant_teamId_machineId_idx" ON "MachineTeamGrant"("teamId", "machineId");
CREATE INDEX "MachineGroupGrant_teamGroupId_machineId_idx" ON "MachineGroupGrant"("teamGroupId", "machineId");
CREATE INDEX "MachineKeyEnvelope_recipientAccountId_machineId_idx" ON "MachineKeyEnvelope"("recipientAccountId", "machineId");

ALTER TABLE "MachineAccountGrant" ADD CONSTRAINT "MachineAccountGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineAccountGrant" ADD CONSTRAINT "MachineAccountGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineAccountGrant" ADD CONSTRAINT "MachineAccountGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineTeamGrant" ADD CONSTRAINT "MachineTeamGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineTeamGrant" ADD CONSTRAINT "MachineTeamGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineTeamGrant" ADD CONSTRAINT "MachineTeamGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineGroupGrant" ADD CONSTRAINT "MachineGroupGrant_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineGroupGrant" ADD CONSTRAINT "MachineGroupGrant_teamGroupId_fkey" FOREIGN KEY ("teamGroupId") REFERENCES "TeamGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineGroupGrant" ADD CONSTRAINT "MachineGroupGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineKeyEnvelope" ADD CONSTRAINT "MachineKeyEnvelope_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MachineKeyEnvelope" ADD CONSTRAINT "MachineKeyEnvelope_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
