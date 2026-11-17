ALTER TABLE "DeploymentEnvironment" ADD COLUMN "telemetryMetricsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "telemetryAppLlmCostEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "telemetryExceptionsEnabled" BOOLEAN NOT NULL DEFAULT false;
