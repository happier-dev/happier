-- Identity snapshots only: historical receipts neither acquire authority nor retain Machine foreign keys.
ALTER TABLE "Deployment" ADD COLUMN "acceptedControllerMachineId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "acceptedControllerInstallationId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "acceptedBuildMachineId" TEXT;
ALTER TABLE "Deployment" ADD COLUMN "acceptedBuildInstallationId" TEXT;
CREATE INDEX "Deployment_acceptedControllerMachineId_state_id_idx" ON "Deployment"("acceptedControllerMachineId", "state", "id");
CREATE INDEX "Deployment_acceptedBuildMachineId_state_id_idx" ON "Deployment"("acceptedBuildMachineId", "state", "id");
