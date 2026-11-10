ALTER TABLE "DeploymentEnvironment" ADD COLUMN "previewCompanionOfEnvironmentId" TEXT REFERENCES "DeploymentEnvironment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "DeploymentEnvironment_previewCompanionOfEnvironmentId_key" ON "DeploymentEnvironment"("previewCompanionOfEnvironmentId");
