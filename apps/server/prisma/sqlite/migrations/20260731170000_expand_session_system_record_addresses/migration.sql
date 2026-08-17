ALTER TABLE "SessionSystemRecord" ADD COLUMN "ownerKind" TEXT;
ALTER TABLE "SessionSystemRecord" ADD COLUMN "pluginId" TEXT;
ALTER TABLE "SessionSystemRecord" ADD COLUMN "namespaceAddressKey" BLOB;
ALTER TABLE "SessionSystemRecord" ADD COLUMN "recordAddressKey" BLOB;
ALTER TABLE "SessionSystemRecord" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
