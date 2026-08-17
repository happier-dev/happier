ALTER TABLE "AccountPluginRelease" ADD COLUMN "packageAssetArchive" JSONB;
ALTER TABLE "AccountPluginRelease" ADD COLUMN "packageAssetArtifactId" TEXT REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "AccountPluginRelease_packageAssetArtifactId_key"
ON "AccountPluginRelease"("packageAssetArtifactId");
