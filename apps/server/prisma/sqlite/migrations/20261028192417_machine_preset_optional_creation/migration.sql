CREATE TABLE "new_ManagedMachinePreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "homeId" TEXT NOT NULL,
    "custodianAccountId" TEXT,
    "teamId" TEXT,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "launch" JSONB,
    "setup" JSONB,
    "controllerMachineId" TEXT,
    "controllerInstallationId" TEXT,
    "retentionOverride" JSONB,
    "wakeOnAcceptedMessage" BOOLEAN,
    "teamAcquireDelegated" BOOLEAN NOT NULL DEFAULT false,
    "simultaneousMaximum" INTEGER,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManagedMachinePreset_custodianAccountId_fkey" FOREIGN KEY ("custodianAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManagedMachinePreset_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManagedMachinePreset_owner_check" CHECK (("custodianAccountId" IS NULL) <> ("teamId" IS NULL)),
    CONSTRAINT "ManagedMachinePreset_limit_check" CHECK ("simultaneousMaximum" IS NULL OR "simultaneousMaximum" > 0)
);
INSERT INTO "new_ManagedMachinePreset" ("id", "homeId", "custodianAccountId", "teamId", "name", "revision", "launch", "setup", "controllerMachineId", "controllerInstallationId", "retentionOverride", "wakeOnAcceptedMessage", "teamAcquireDelegated", "simultaneousMaximum", "archivedAt", "createdAt", "updatedAt")
SELECT "id", "homeId", "custodianAccountId", "teamId", "name", "revision", "launch", "setup", "controllerMachineId", "controllerInstallationId", "retentionOverride", "wakeOnAcceptedMessage", "teamAcquireDelegated", "simultaneousMaximum", "archivedAt", "createdAt", "updatedAt" FROM "ManagedMachinePreset";
DROP TABLE "ManagedMachinePreset";
ALTER TABLE "new_ManagedMachinePreset" RENAME TO "ManagedMachinePreset";
CREATE INDEX "ManagedMachinePreset_homeId_custodianAccountId_idx" ON "ManagedMachinePreset"("homeId", "custodianAccountId");
CREATE INDEX "ManagedMachinePreset_homeId_teamId_idx" ON "ManagedMachinePreset"("homeId", "teamId");
