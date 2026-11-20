CREATE TABLE "QualifiedConnectedAccountUsageRefusal" (
    "accountId" TEXT NOT NULL,
    "qualifiedIdentityDigest" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("accountId", "qualifiedIdentityDigest", "credentialId"),
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY ("credentialId") REFERENCES "ServiceAccountToken"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "qcau_refusal_credential_idx" ON "QualifiedConnectedAccountUsageRefusal"("credentialId");
