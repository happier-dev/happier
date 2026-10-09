CREATE TABLE "ManagedMachine" (
    "id" TEXT NOT NULL,
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
    "desiredAfterMs" DOUBLE PRECISION,
    "intentRevision" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "retention" JSONB NOT NULL,
    "wakeOnAcceptedMessage" BOOLEAN NOT NULL,
    "observation" JSONB,
    "cleanup" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ManagedMachine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ManagedMachine_custodianAccountId_fkey" FOREIGN KEY ("custodianAccountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ManagedMachine_enrolledMachineId_fkey" FOREIGN KEY ("enrolledMachineId") REFERENCES "Machine" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE "ManagedMachinePreset" (
    "id" TEXT NOT NULL,
    "homeId" TEXT NOT NULL,
    "custodianAccountId" TEXT,
    "teamId" TEXT,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "launch" JSONB NOT NULL,
    "controllerMachineId" TEXT NOT NULL,
    "controllerInstallationId" TEXT NOT NULL,
    "retentionOverride" JSONB,
    "wakeOnAcceptedMessage" BOOLEAN,
    "simultaneousMaximum" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ManagedMachinePreset_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ManagedMachinePreset_custodianAccountId_fkey" FOREIGN KEY ("custodianAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManagedMachinePreset_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ManagedMachinePreset_owner_check" CHECK (("custodianAccountId" IS NULL) <> ("teamId" IS NULL)),
    CONSTRAINT "ManagedMachinePreset_limit_check" CHECK ("simultaneousMaximum" IS NULL OR "simultaneousMaximum" > 0)
);
CREATE UNIQUE INDEX "ManagedMachine_enrolledMachineId_key" ON "ManagedMachine"("enrolledMachineId");
CREATE UNIQUE INDEX "ManagedMachine_homeId_admittedActionRequestId_key" ON "ManagedMachine"("homeId", "admittedActionRequestId");
CREATE INDEX "ManagedMachine_homeId_custodianAccountId_archivedAt_createdAt_idx" ON "ManagedMachine"("homeId", "custodianAccountId", "archivedAt", "createdAt");
CREATE INDEX "ManagedMachine_controllerMachineId_controllerInstallationId_idx" ON "ManagedMachine"("controllerMachineId", "controllerInstallationId");
CREATE INDEX "ManagedMachinePreset_homeId_custodianAccountId_idx" ON "ManagedMachinePreset"("homeId", "custodianAccountId");
CREATE INDEX "ManagedMachinePreset_homeId_teamId_idx" ON "ManagedMachinePreset"("homeId", "teamId");
