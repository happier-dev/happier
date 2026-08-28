-- Account-scoped Automation policy must remain readable by the server while
-- private Account settings are E2EE. Existing Accounts retain the product
-- default without a data backfill.
ALTER TABLE "Account"
    ADD COLUMN "automationMaxActiveRunsPerMachine" INTEGER NOT NULL DEFAULT 4,
    ADD COLUMN "automationRunRetention" TEXT NOT NULL DEFAULT 'thirtyDays';
