-- AlterTable
ALTER TABLE "AccountChange" ADD COLUMN     "accountPetPackageId" TEXT;

-- CreateTable
CREATE TABLE "AccountPetPackage" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "packageFormat" TEXT NOT NULL,
    "contentMode" TEXT NOT NULL DEFAULT 'plain',
    "manifest" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "origin" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountPetPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountPetAsset" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "petPackageId" TEXT NOT NULL,
    "contentMode" TEXT NOT NULL DEFAULT 'plain',
    "storageKind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "mediaType" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountPetAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountPetPackage_accountId_id_key" ON "AccountPetPackage"("accountId", "id");

-- CreateIndex
CREATE INDEX "AccountPetPackage_accountId_deletedAt_updatedAt_idx" ON "AccountPetPackage"("accountId", "deletedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "AccountPetPackage_accountId_digest_idx" ON "AccountPetPackage"("accountId", "digest");

-- CreateIndex
CREATE INDEX "AccountPetAsset_accountId_idx" ON "AccountPetAsset"("accountId");

-- CreateIndex
CREATE INDEX "AccountPetAsset_accountId_petPackageId_idx" ON "AccountPetAsset"("accountId", "petPackageId");

-- CreateIndex
CREATE INDEX "AccountPetAsset_petPackageId_idx" ON "AccountPetAsset"("petPackageId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountPetAsset_accountId_objectKey_key" ON "AccountPetAsset"("accountId", "objectKey");

-- AddForeignKey
ALTER TABLE "AccountPetPackage" ADD CONSTRAINT "AccountPetPackage_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPetAsset" ADD CONSTRAINT "AccountPetAsset_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountPetAsset" ADD CONSTRAINT "AccountPetAsset_accountId_petPackageId_fkey" FOREIGN KEY ("accountId", "petPackageId") REFERENCES "AccountPetPackage"("accountId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountChange" ADD CONSTRAINT "AccountChange_accountPetPackageId_fkey" FOREIGN KEY ("accountPetPackageId") REFERENCES "AccountPetPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
