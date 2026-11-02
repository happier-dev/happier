-- Nullable self-reference adds lineage without rebuilding retained link rows.
ALTER TABLE "DeploymentTargetLink" ADD COLUMN "predecessorTargetLinkId" TEXT
    REFERENCES "DeploymentTargetLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
