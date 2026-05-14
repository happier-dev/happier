CREATE TABLE "SessionFolderAssignment" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "folderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionFolderAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SessionFolderAssignment_accountId_sessionId_key" ON "SessionFolderAssignment"("accountId", "sessionId");
CREATE INDEX "SessionFolderAssignment_accountId_folderId_updatedAt_idx" ON "SessionFolderAssignment"("accountId", "folderId", "updatedAt");
CREATE INDEX "SessionFolderAssignment_sessionId_idx" ON "SessionFolderAssignment"("sessionId");

ALTER TABLE "SessionFolderAssignment" ADD CONSTRAINT "SessionFolderAssignment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionFolderAssignment" ADD CONSTRAINT "SessionFolderAssignment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
