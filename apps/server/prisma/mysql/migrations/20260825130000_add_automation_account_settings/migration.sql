-- Account-scoped Automation policy remains server-readable while private
-- Account settings may be E2EE. These constant defaults backfill existing rows.
ALTER TABLE `Account`
    ADD COLUMN `automationMaxActiveRunsPerMachine` INTEGER NOT NULL DEFAULT 4,
    ADD COLUMN `automationRunRetention` VARCHAR(191) NOT NULL DEFAULT 'thirtyDays';
