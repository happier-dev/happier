ALTER TABLE "AccountPluginRelease"
    ADD COLUMN "packageAssetArchive" JSONB,
    ADD COLUMN "packageAssetArtifactId" TEXT;

CREATE UNIQUE INDEX "AccountPluginRelease_packageAssetArtifactId_key"
ON "AccountPluginRelease"("packageAssetArtifactId");

ALTER TABLE "AccountPluginRelease"
    ADD CONSTRAINT "AccountPluginRelease_packageAssetArtifactId_fkey"
    FOREIGN KEY ("packageAssetArtifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
