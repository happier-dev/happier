ALTER TABLE "Machine" ADD COLUMN "terminalAuthRequestId" TEXT;
CREATE UNIQUE INDEX "Machine_terminalAuthRequestId_key" ON "Machine"("terminalAuthRequestId");
CREATE INDEX "Machine_deploymentAppDeploymentId_idx" ON "Machine"("deploymentAppDeploymentId");
