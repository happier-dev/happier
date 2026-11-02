-- Replaced links retain their workload custody and receipt lineage.
ALTER TABLE "DeploymentTargetLink" ADD COLUMN "predecessorTargetLinkId" TEXT;
ALTER TABLE "DeploymentTargetLink" ADD CONSTRAINT "DeploymentTargetLink_predecessorTargetLinkId_fkey"
    FOREIGN KEY ("predecessorTargetLinkId") REFERENCES "DeploymentTargetLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
