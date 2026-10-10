PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ManagedMachine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "homeId" TEXT NOT NULL,
    "custodianAccountId" TEXT NOT NULL,
    "controllerMachineId" TEXT NOT NULL,
    "controllerInstallationId" TEXT NOT NULL,
    "admittedActionRequestId" TEXT NOT NULL,
    "admittedInput" JSONB NOT NULL,
    "presetId" TEXT,
    "presetRevision" INTEGER,
    "launch" JSONB NOT NULL,
    "reviewedFacts" JSONB,
    "allocation" TEXT NOT NULL DEFAULT 'unsubmitted',
    "creationState" TEXT NOT NULL DEFAULT 'active',
    "resource" JSONB,
    "nativeOperationRef" JSONB,
    "recovery" JSONB,
    "bootstrapCredentialRef" JSONB,
    "enrolledMachineId" TEXT,
    "desired" TEXT NOT NULL DEFAULT 'start',
    "desiredWhen" TEXT NOT NULL DEFAULT 'now',
    "desiredAfterMs" REAL,
    "intentRevision" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" DATETIME,
    "retention" JSONB NOT NULL,
    "wakeOnAcceptedMessage" BOOLEAN NOT NULL,
    "observation" JSONB,
    "cleanup" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManagedMachine_custodianAccountId_fkey" FOREIGN KEY ("custodianAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ManagedMachine_enrolledMachineId_fkey" FOREIGN KEY ("enrolledMachineId") REFERENCES "Machine" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ManagedMachine" ("id", "homeId", "custodianAccountId", "controllerMachineId", "controllerInstallationId", "admittedActionRequestId", "admittedInput", "presetId", "presetRevision", "launch", "reviewedFacts", "allocation", "creationState", "resource", "nativeOperationRef", "recovery", "bootstrapCredentialRef", "enrolledMachineId", "desired", "desiredWhen", "desiredAfterMs", "intentRevision", "archivedAt", "retention", "wakeOnAcceptedMessage", "observation", "cleanup", "createdAt", "updatedAt")
SELECT "id", "homeId", "custodianAccountId", "controllerMachineId", "controllerInstallationId", "admittedActionRequestId", "admittedInput", "presetId", "presetRevision", "launch", "reviewedFacts", "allocation", "creationState", "resource", "nativeOperationRef", "recovery", "bootstrapCredentialRef", "enrolledMachineId", "desired", "desiredWhen", CAST("desiredAfterMs" AS REAL), "intentRevision", "archivedAt", "retention", "wakeOnAcceptedMessage", "observation", "cleanup", "createdAt", "updatedAt" FROM "ManagedMachine";
DROP TABLE "ManagedMachine";
ALTER TABLE "new_ManagedMachine" RENAME TO "ManagedMachine";
CREATE UNIQUE INDEX "ManagedMachine_enrolledMachineId_key" ON "ManagedMachine"("enrolledMachineId");
CREATE UNIQUE INDEX "ManagedMachine_homeId_admittedActionRequestId_key" ON "ManagedMachine"("homeId", "admittedActionRequestId");
CREATE INDEX "ManagedMachine_homeId_custodianAccountId_archivedAt_createdAt_idx" ON "ManagedMachine"("homeId", "custodianAccountId", "archivedAt", "createdAt");
CREATE INDEX "ManagedMachine_controllerMachineId_controllerInstallationId_idx" ON "ManagedMachine"("controllerMachineId", "controllerInstallationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
