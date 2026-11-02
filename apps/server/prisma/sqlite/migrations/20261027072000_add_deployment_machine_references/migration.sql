-- Nullable additions preserve S0 rows and their existing constraints in place.
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "edgeMachineId" TEXT REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DeploymentTargetLink" ADD COLUMN "detachedAt" DATETIME;
CREATE INDEX "DeploymentEnvironment_edgeMachineId_deletedAt_id_idx" ON "DeploymentEnvironment"("edgeMachineId", "deletedAt", "id");
