ALTER TABLE "DeploymentEnvironment" ADD COLUMN "previewCompanionOfEnvironmentId" TEXT;
CREATE UNIQUE INDEX "DeploymentEnvironment_previewCompanionOfEnvironmentId_key" ON "DeploymentEnvironment"("previewCompanionOfEnvironmentId");
ALTER TABLE "DeploymentEnvironment" ADD CONSTRAINT "DeploymentEnvironment_previewCompanionOfEnvironmentId_fkey" FOREIGN KEY ("previewCompanionOfEnvironmentId") REFERENCES "DeploymentEnvironment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
