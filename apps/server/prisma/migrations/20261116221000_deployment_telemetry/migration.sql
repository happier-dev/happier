ALTER TABLE "DeploymentEnvironment" ADD COLUMN "telemetryMachineId" TEXT,
ADD COLUMN "telemetryTokenHash" TEXT;

CREATE INDEX "DeploymentEnvironment_telemetryMachineId_deletedAt_id_idx" ON "DeploymentEnvironment"("telemetryMachineId", "deletedAt", "id");

ALTER TABLE "DeploymentEnvironment" ADD CONSTRAINT "DeploymentEnvironment_telemetryMachineId_fkey" FOREIGN KEY ("telemetryMachineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
