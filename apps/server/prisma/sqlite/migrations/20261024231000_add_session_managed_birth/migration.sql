ALTER TABLE "Session" ADD COLUMN "managedCreationId" TEXT REFERENCES "ManagedMachine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Session_account_managed_creation_idx" ON "Session"("accountId", "managedCreationId");
