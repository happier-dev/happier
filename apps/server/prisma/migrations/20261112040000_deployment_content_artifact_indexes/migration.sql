-- Source-audience reverse lookup reads deployment content by its Artifact id.
CREATE INDEX "DeploymentEnvironment_contentArtifactId_idx" ON "DeploymentEnvironment"("contentArtifactId");
CREATE INDEX "DeploymentTargetLink_contentArtifactId_idx" ON "DeploymentTargetLink"("contentArtifactId");
CREATE INDEX "Deployment_contentArtifactId_idx" ON "Deployment"("contentArtifactId");
CREATE INDEX "DeploymentDomain_contentArtifactId_idx" ON "DeploymentDomain"("contentArtifactId");
