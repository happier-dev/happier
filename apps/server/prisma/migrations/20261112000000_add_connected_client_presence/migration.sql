-- CreateTable
CREATE TABLE "ConnectedClientPresence" (
    "accountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedClientPresence_pkey" PRIMARY KEY ("accountId","clientId")
);

-- AddForeignKey
ALTER TABLE "ConnectedClientPresence" ADD CONSTRAINT "ConnectedClientPresence_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

