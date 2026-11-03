-- Immutable executor routing for newly admitted Workflow Run assignments.
ALTER TABLE "AutomationRunAssignment" ADD COLUMN "admittedMachineInstallationId" TEXT;
