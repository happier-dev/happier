UPDATE "Session" SET "currentStorageState" = 'machine_only'
WHERE "cloudCopyLeftAt" IS NOT NULL AND "currentStorageState" = 'hosted';
