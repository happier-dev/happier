-- Nullable self-reference retains source receipts without rebuilding retained rows.
ALTER TABLE "Deployment" ADD COLUMN "promotedFromDeploymentId" TEXT
    REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
