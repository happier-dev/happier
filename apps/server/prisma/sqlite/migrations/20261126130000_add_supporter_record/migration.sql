-- CreateTable
CREATE TABLE "SupporterRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "number" INTEGER,
    "accountId" TEXT,
    "kind" TEXT,
    "grantedAt" DATETIME,
    "recurringActive" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SupporterRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SupporterRecord_code_key" ON "SupporterRecord"("code");

-- CreateIndex
CREATE UNIQUE INDEX "SupporterRecord_number_key" ON "SupporterRecord"("number");

-- CreateIndex
CREATE UNIQUE INDEX "SupporterRecord_accountId_key" ON "SupporterRecord"("accountId");
