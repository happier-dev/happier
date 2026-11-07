-- Existing Teams inherit user defaults until an administrator configures them.
ALTER TABLE "Team" ADD COLUMN "managedDefaults" JSONB;
