-- P3 U3 (D13): agents may be given the two write levels; the default stays 'read'.
-- SQLite cannot alter a column CHECK; re-add the column and carry its values.
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "dataAgentAccessCarry" TEXT;
UPDATE "DeploymentEnvironment" SET "dataAgentAccessCarry" = "dataAgentAccess";
ALTER TABLE "DeploymentEnvironment" DROP COLUMN "dataAgentAccess";
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "dataAgentAccess" TEXT NOT NULL DEFAULT 'read'
    CONSTRAINT "DeploymentEnvironment_dataAgentAccess_check"
    CHECK ("dataAgentAccess" IN ('none', 'read', 'readWriteAsk', 'readWriteNoApproval'));
UPDATE "DeploymentEnvironment" SET "dataAgentAccess" = "dataAgentAccessCarry";
ALTER TABLE "DeploymentEnvironment" DROP COLUMN "dataAgentAccessCarry";
