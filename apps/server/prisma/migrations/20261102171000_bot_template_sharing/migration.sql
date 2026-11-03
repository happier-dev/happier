-- Bot templates: authenticated link admission and best-effort direct-copy version reports.
-- CreateTable
CREATE TABLE "ArtifactSignedInLink" (
    "artifactId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "encryptedDataKey" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArtifactSignedInLink_pkey" PRIMARY KEY ("artifactId")
);

-- CreateTable
CREATE TABLE "ArtifactTemplateAcceptedVersion" (
    "artifactId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "copyId" TEXT NOT NULL,
    "acceptedVersion" TEXT NOT NULL,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactTemplateAcceptedVersion_pkey" PRIMARY KEY ("artifactId","recipientAccountId","copyId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactSignedInLink_tokenHash_key" ON "ArtifactSignedInLink"("tokenHash");

-- AddForeignKey
ALTER TABLE "ArtifactSignedInLink" ADD CONSTRAINT "ArtifactSignedInLink_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactSignedInLink" ADD CONSTRAINT "ArtifactSignedInLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactTemplateAcceptedVersion" ADD CONSTRAINT "ArtifactTemplateAcceptedVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArtifactTemplateAcceptedVersion" ADD CONSTRAINT "ArtifactTemplateAcceptedVersion_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

