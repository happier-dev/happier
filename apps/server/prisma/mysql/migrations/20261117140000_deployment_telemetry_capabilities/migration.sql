ALTER TABLE `DeploymentEnvironment`
ADD COLUMN `telemetryMetricsEnabled` BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN `telemetryAppLlmCostEnabled` BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN `telemetryExceptionsEnabled` BOOLEAN NOT NULL DEFAULT false;
