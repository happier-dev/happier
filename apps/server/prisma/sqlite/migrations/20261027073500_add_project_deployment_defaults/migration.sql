CREATE TABLE "ProjectDeploymentDefaults" (
    "projectSourceId" TEXT NOT NULL PRIMARY KEY,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "contentArtifactId" TEXT,
    "contentHeaderVersion" INTEGER,
    "contentBodyVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectDeploymentDefaults_content_check" CHECK (
        ("contentHeaderVersion" IS NULL AND "contentBodyVersion" IS NULL)
        OR ("contentHeaderVersion" IS NOT NULL AND "contentBodyVersion" IS NOT NULL
            AND "contentHeaderVersion" > 0 AND "contentBodyVersion" > 0)
    ),
    CONSTRAINT "ProjectDeploymentDefaults_projectSourceId_fkey" FOREIGN KEY ("projectSourceId") REFERENCES "ProjectSource"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectDeploymentDefaults_contentArtifactId_fkey" FOREIGN KEY ("contentArtifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ProjectDeploymentDefaults_contentArtifactId_idx" ON "ProjectDeploymentDefaults"("contentArtifactId");
