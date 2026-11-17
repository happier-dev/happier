ALTER TABLE "DeploymentEnvironment" ADD COLUMN "telemetryMachineId" TEXT REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "telemetryTokenHash" TEXT;

CREATE INDEX "DeploymentEnvironment_telemetryMachineId_deletedAt_id_idx" ON "DeploymentEnvironment"("telemetryMachineId", "deletedAt", "id");
