BEGIN;

-- DropForeignKey
ALTER TABLE "Deployment" DROP CONSTRAINT "Deployment_contentArtifactId_fkey";

-- AlterTable
ALTER TABLE "Deployment" ALTER COLUMN "contentArtifactId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
