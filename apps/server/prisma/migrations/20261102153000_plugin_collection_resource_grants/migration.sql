-- CreateTable
CREATE TABLE "PluginCollectionAccountGrant" (
    "rowDbId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accessLevel" "ShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginCollectionAccountGrant_pkey" PRIMARY KEY ("rowDbId","accountId")
);

-- CreateTable
CREATE TABLE "PluginCollectionTeamGrant" (
    "rowDbId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "accessLevel" "ShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginCollectionTeamGrant_pkey" PRIMARY KEY ("rowDbId","teamId")
);

-- CreateTable
CREATE TABLE "PluginCollectionGroupGrant" (
    "rowDbId" TEXT NOT NULL,
    "teamGroupId" TEXT NOT NULL,
    "accessLevel" "ShareAccessLevel" NOT NULL,
    "createdByAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginCollectionGroupGrant_pkey" PRIMARY KEY ("rowDbId","teamGroupId")
);

-- CreateTable
CREATE TABLE "PluginCollectionKeyEnvelope" (
    "rowDbId" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "encryptedDataKey" BYTEA NOT NULL,
    "recipientContentPublicKeyFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginCollectionKeyEnvelope_pkey" PRIMARY KEY ("rowDbId","recipientAccountId")
);

-- CreateIndex
CREATE INDEX "PluginCollectionAccountGrant_accountId_rowDbId_idx" ON "PluginCollectionAccountGrant"("accountId", "rowDbId");

-- CreateIndex
CREATE INDEX "PluginCollectionTeamGrant_teamId_rowDbId_idx" ON "PluginCollectionTeamGrant"("teamId", "rowDbId");

-- CreateIndex
CREATE INDEX "PluginCollectionGroupGrant_teamGroupId_rowDbId_idx" ON "PluginCollectionGroupGrant"("teamGroupId", "rowDbId");

-- CreateIndex
CREATE INDEX "PluginCollectionKeyEnvelope_recipientAccountId_rowDbId_idx" ON "PluginCollectionKeyEnvelope"("recipientAccountId", "rowDbId");

-- AddForeignKey
ALTER TABLE "PluginCollectionAccountGrant" ADD CONSTRAINT "PluginCollectionAccountGrant_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionAccountGrant" ADD CONSTRAINT "PluginCollectionAccountGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionAccountGrant" ADD CONSTRAINT "PluginCollectionAccountGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionTeamGrant" ADD CONSTRAINT "PluginCollectionTeamGrant_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionTeamGrant" ADD CONSTRAINT "PluginCollectionTeamGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionTeamGrant" ADD CONSTRAINT "PluginCollectionTeamGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionGroupGrant" ADD CONSTRAINT "PluginCollectionGroupGrant_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionGroupGrant" ADD CONSTRAINT "PluginCollectionGroupGrant_teamGroupId_fkey" FOREIGN KEY ("teamGroupId") REFERENCES "TeamGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionGroupGrant" ADD CONSTRAINT "PluginCollectionGroupGrant_createdByAccountId_fkey" FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionKeyEnvelope" ADD CONSTRAINT "PluginCollectionKeyEnvelope_rowDbId_fkey" FOREIGN KEY ("rowDbId") REFERENCES "PluginCollectionRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginCollectionKeyEnvelope" ADD CONSTRAINT "PluginCollectionKeyEnvelope_recipientAccountId_fkey" FOREIGN KEY ("recipientAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

