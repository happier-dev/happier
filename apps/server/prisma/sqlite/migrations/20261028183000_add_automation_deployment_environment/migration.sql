ALTER TABLE "Automation" ADD COLUMN "deploymentEnvironmentId" TEXT REFERENCES "DeploymentEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Automation_deploymentEnvironmentId_deletedAt_id_idx" ON "Automation"("deploymentEnvironmentId", "deletedAt", "id");
