-- CreateTable
CREATE TABLE "SupporterRecord" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "number" INTEGER,
    "accountId" TEXT,
    "kind" TEXT,
    "grantedAt" TIMESTAMP(3),
    "recurringActive" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupporterRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupporterRecord_code_key" ON "SupporterRecord"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SupporterRecord_number_key" ON "SupporterRecord"("number");

-- CreateIndex
CREATE UNIQUE INDEX "SupporterRecord_accountId_key" ON "SupporterRecord"("accountId");

-- AddForeignKey
ALTER TABLE "SupporterRecord" ADD CONSTRAINT "SupporterRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
