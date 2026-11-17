ALTER TABLE "TerminalAuthRequest" ADD COLUMN "deploymentAppEnrollment" JSONB;
ALTER TABLE "Machine" ADD COLUMN "deploymentAppDeploymentId" TEXT;
