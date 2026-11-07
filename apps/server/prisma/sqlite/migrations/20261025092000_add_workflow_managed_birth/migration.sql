ALTER TABLE "AutomationRun" ADD COLUMN "managedCreationId" TEXT REFERENCES "ManagedMachine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "AutomationRun_account_managed_creation_idx" ON "AutomationRun"("accountId", "managedCreationId");
