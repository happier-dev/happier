-- Add the Account Service's directory metadata and Home-side issuer links.
ALTER TABLE "Account" ADD COLUMN "preferredHomeServerIdentityId" TEXT;

CREATE TABLE "AccountHomeDirectoryEntry" (
    "accountId" TEXT NOT NULL,
    "homeServerIdentityId" TEXT NOT NULL,
    "canonicalServerUrl" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "connectionDescriptor" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountHomeDirectoryEntry_pkey" PRIMARY KEY ("accountId", "homeServerIdentityId")
);

CREATE INDEX "AccountHomeDirectoryEntry_accountId_updatedAt_idx"
ON "AccountHomeDirectoryEntry"("accountId", "updatedAt");

ALTER TABLE "AccountHomeDirectoryEntry"
ADD CONSTRAINT "AccountHomeDirectoryEntry_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AccountDirectoryLink" (
    "accountId" TEXT NOT NULL,
    "issuerServerIdentityId" TEXT NOT NULL,
    "issuerSubjectId" TEXT NOT NULL,
    "issuerSigningKeyId" TEXT NOT NULL,
    "issuerSigningPublicKey" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDirectoryLink_pkey" PRIMARY KEY ("issuerServerIdentityId", "issuerSubjectId")
);

CREATE UNIQUE INDEX "AccountDirectoryLink_accountId_issuerServerIdentityId_key"
ON "AccountDirectoryLink"("accountId", "issuerServerIdentityId");

CREATE INDEX "AccountDirectoryLink_accountId_idx"
ON "AccountDirectoryLink"("accountId");

ALTER TABLE "AccountDirectoryLink"
ADD CONSTRAINT "AccountDirectoryLink_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
