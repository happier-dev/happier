ALTER TABLE "AppLockMailSettings" ADD COLUMN "recoveryEmail" TEXT;

UPDATE "AppLockMailSettings" AS settings
SET "recoveryEmail" = (
    SELECT recovery."email"
    FROM "AppLockRecovery" AS recovery
    WHERE recovery."accountId" = settings."accountId"
    ORDER BY recovery."updatedAt" DESC, recovery."id" DESC
    LIMIT 1
)
WHERE EXISTS (
    SELECT 1
    FROM "AppLockRecovery" AS recovery
    WHERE recovery."accountId" = settings."accountId"
);
