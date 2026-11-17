-- P3 U3 (D13): agents may be given the two write levels; the default stays 'read'.
ALTER TABLE "DeploymentEnvironment" DROP CONSTRAINT "DeploymentEnvironment_dataAgentAccess_check",
    ADD CONSTRAINT "DeploymentEnvironment_dataAgentAccess_check"
    CHECK ("dataAgentAccess" IN ('none', 'read', 'readWriteAsk', 'readWriteNoApproval'));
