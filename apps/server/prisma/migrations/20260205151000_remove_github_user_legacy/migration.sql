-- Drop legacy GitHub linkage on Account in favor of AccountIdentity(provider="github").

INSERT INTO "AccountIdentity" (
    "id",
    "accountId",
    "provider",
    "providerUserId",
    "providerLogin",
    "profile",
    "token",
    "createdAt",
    "updatedAt"
)
SELECT
    'gh-legacy-' || a."id",
    a."id",
    'github',
    a."githubUserId",
    g."profile"->>'login',
    g."profile",
    g."token",
    NOW(),
    NOW()
FROM "Account" a
LEFT JOIN "GithubUser" g ON g."id" = a."githubUserId"
WHERE a."githubUserId" IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE "Account" DROP CONSTRAINT IF EXISTS "Account_githubUserId_fkey";
DROP INDEX IF EXISTS "Account_githubUserId_key";
ALTER TABLE "Account" DROP COLUMN IF EXISTS "githubUserId";

DROP TABLE IF EXISTS "GithubUser";
