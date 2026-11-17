ALTER TABLE "TerminalAuthRequest" ADD COLUMN "deploymentAppEnrollment" JSON;
ALTER TABLE "Machine" ADD COLUMN "deploymentAppDeploymentId" TEXT;
