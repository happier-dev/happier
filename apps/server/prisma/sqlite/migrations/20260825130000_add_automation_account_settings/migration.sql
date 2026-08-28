-- Account-scoped Automation policy remains server-readable while private
-- Account settings may be E2EE. SQLite supports these constant defaults in place.
ALTER TABLE "Account" ADD COLUMN "automationMaxActiveRunsPerMachine" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "Account" ADD COLUMN "automationRunRetention" TEXT NOT NULL DEFAULT 'thirtyDays';
