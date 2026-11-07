-- The runner disables foreign keys before its transaction so rebuilding this
-- parent retains Session/AutomationRun birth references without SET NULL effects.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ManagedMachine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "homeId" TEXT NOT NULL,
    "custodianAccountId" TEXT NOT NULL,
    "controllerMachineId" TEXT,
    "controllerInstallationId" TEXT,
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
    "machineSetup" JSONB,
    CONSTRAINT "ManagedMachine_custodianAccountId_fkey" FOREIGN KEY ("custodianAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ManagedMachine_enrolledMachineId_fkey" FOREIGN KEY ("enrolledMachineId") REFERENCES "Machine" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ManagedMachine_controller_pair_check" CHECK (("controllerMachineId" IS NULL) = ("controllerInstallationId" IS NULL))
);

INSERT INTO "new_ManagedMachine" (
    "id", "homeId", "custodianAccountId", "controllerMachineId", "controllerInstallationId",
    "admittedActionRequestId", "admittedInput", "presetId", "presetRevision", "launch", "reviewedFacts",
    "allocation", "creationState", "resource", "nativeOperationRef", "recovery", "bootstrapCredentialRef",
    "enrolledMachineId", "desired", "desiredWhen", "desiredAfterMs", "intentRevision", "archivedAt",
    "retention", "wakeOnAcceptedMessage", "observation", "cleanup", "createdAt", "updatedAt", "machineSetup"
)
SELECT
    "id", "homeId", "custodianAccountId", "controllerMachineId", "controllerInstallationId",
    "admittedActionRequestId", "admittedInput", "presetId", "presetRevision", "launch", "reviewedFacts",
    "allocation", "creationState", "resource", "nativeOperationRef", "recovery", "bootstrapCredentialRef",
    "enrolledMachineId", "desired", "desiredWhen", "desiredAfterMs", "intentRevision", "archivedAt",
    "retention", "wakeOnAcceptedMessage", "observation", "cleanup", "createdAt", "updatedAt", "machineSetup"
FROM "ManagedMachine";

DROP TABLE "ManagedMachine";
ALTER TABLE "new_ManagedMachine" RENAME TO "ManagedMachine";
CREATE UNIQUE INDEX "ManagedMachine_enrolledMachineId_key" ON "ManagedMachine"("enrolledMachineId");
CREATE UNIQUE INDEX "ManagedMachine_homeId_admittedActionRequestId_key" ON "ManagedMachine"("homeId", "admittedActionRequestId");
CREATE INDEX "ManagedMachine_home_custodian_archived_idx" ON "ManagedMachine"("homeId", "custodianAccountId", "archivedAt", "createdAt");
CREATE INDEX "ManagedMachine_controllerMachineId_controllerInstallationId_idx" ON "ManagedMachine"("controllerMachineId", "controllerInstallationId");

PRAGMA foreign_keys=ON;
