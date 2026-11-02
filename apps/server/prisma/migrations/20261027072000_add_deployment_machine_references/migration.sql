-- Retain Machine custody independently of current runtime membership.
ALTER TABLE "DeploymentEnvironment" ADD COLUMN "edgeMachineId" TEXT;
ALTER TABLE "DeploymentTargetLink" ADD COLUMN "detachedAt" TIMESTAMP(3);
CREATE INDEX "DeploymentEnvironment_edgeMachineId_deletedAt_id_idx" ON "DeploymentEnvironment"("edgeMachineId", "deletedAt", "id");
ALTER TABLE "DeploymentEnvironment" ADD CONSTRAINT "DeploymentEnvironment_edgeMachineId_fkey" FOREIGN KEY ("edgeMachineId") REFERENCES "Machine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
