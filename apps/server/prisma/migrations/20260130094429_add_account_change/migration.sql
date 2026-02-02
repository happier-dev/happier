-- CreateTable
CREATE TABLE "AccountChange" (
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "cursor" INTEGER NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hint" JSONB,

    CONSTRAINT "AccountChange_pkey" PRIMARY KEY ("accountId","kind","entityId"),
    CONSTRAINT "AccountChange_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AccountChange_accountId_cursor_idx" ON "AccountChange"("accountId", "cursor");
