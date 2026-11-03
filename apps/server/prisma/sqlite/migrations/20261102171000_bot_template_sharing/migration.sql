-- Bot templates: authenticated link admission and best-effort direct-copy version reports.
-- CreateTable
CREATE TABLE "ArtifactSignedInLink" (
    "artifactId" TEXT NOT NULL PRIMARY KEY,
    "createdByUserId" TEXT NOT NULL,
    "tokenHash" BLOB NOT NULL,
    "encryptedDataKey" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ArtifactSignedInLink_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactSignedInLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ArtifactTemplateAcceptedVersion" (
    "artifactId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "copyId" TEXT NOT NULL,
    "acceptedVersion" TEXT NOT NULL,
    "reportedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("artifactId", "recipientAccountId", "copyId"),
    CONSTRAINT "ArtifactTemplateAcceptedVersion_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "Artifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ArtifactTemplateAcceptedVersion_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ArtifactSignedInLink_tokenHash_key" ON "ArtifactSignedInLink"("tokenHash");

