-- Add the Account Service's directory metadata and Home-side issuer links.
ALTER TABLE "Account" ADD COLUMN "preferredHomeServerIdentityId" TEXT;

CREATE TABLE "AccountHomeDirectoryEntry" (
    "accountId" TEXT NOT NULL,
    "homeServerIdentityId" TEXT NOT NULL,
    "canonicalServerUrl" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "connectionDescriptor" JSON NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "AccountHomeDirectoryEntry_pkey" PRIMARY KEY ("accountId", "homeServerIdentityId"),
    CONSTRAINT "AccountHomeDirectoryEntry_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AccountHomeDirectoryEntry_accountId_updatedAt_idx"
ON "AccountHomeDirectoryEntry"("accountId", "updatedAt");

CREATE TABLE "AccountDirectoryLink" (
    "accountId" TEXT NOT NULL,
    "issuerServerIdentityId" TEXT NOT NULL,
    "issuerSubjectId" TEXT NOT NULL,
    "issuerSigningKeyId" TEXT NOT NULL,
    "issuerSigningPublicKey" BLOB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    CONSTRAINT "AccountDirectoryLink_pkey" PRIMARY KEY ("issuerServerIdentityId", "issuerSubjectId"),
    CONSTRAINT "AccountDirectoryLink_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AccountDirectoryLink_accountId_issuerServerIdentityId_key"
ON "AccountDirectoryLink"("accountId", "issuerServerIdentityId");

CREATE INDEX "AccountDirectoryLink_accountId_idx"
ON "AccountDirectoryLink"("accountId");
