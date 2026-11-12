-- CreateTable
CREATE TABLE "ConnectedClientPresence" (
    "accountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,

    PRIMARY KEY ("accountId", "clientId"),
    CONSTRAINT "ConnectedClientPresence_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

