CREATE TABLE "QualifiedConnectedAccountUsageRefusal" (
    "accountId" TEXT NOT NULL,
    "qualifiedIdentityDigest" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qcau_refusal_key" PRIMARY KEY ("accountId", "qualifiedIdentityDigest", "credentialId")
);

CREATE INDEX "qcau_refusal_credential_idx" ON "QualifiedConnectedAccountUsageRefusal"("credentialId");

ALTER TABLE "QualifiedConnectedAccountUsageRefusal" ADD CONSTRAINT "qcau_refusal_account_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "QualifiedConnectedAccountUsageRefusal" ADD CONSTRAINT "qcau_refusal_credential_fkey"
    FOREIGN KEY ("credentialId") REFERENCES "ServiceAccountToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;
