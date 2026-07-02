DELETE FROM "ConnectedServiceAuthGroupMember"
WHERE NOT EXISTS (
    SELECT 1
    FROM "ServiceAccountToken" AS credential
    WHERE credential."accountId" = "ConnectedServiceAuthGroupMember"."accountId"
      AND credential."vendor" = "ConnectedServiceAuthGroupMember"."vendor"
      AND credential."profileId" = "ConnectedServiceAuthGroupMember"."profileId"
);

UPDATE "ConnectedServiceAuthGroup"
SET
    "activeProfileId" = NULL,
    "generation" = "generation" + 1
WHERE "activeProfileId" IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "ServiceAccountToken" AS credential
      WHERE credential."accountId" = "ConnectedServiceAuthGroup"."accountId"
        AND credential."vendor" = "ConnectedServiceAuthGroup"."vendor"
        AND credential."profileId" = "ConnectedServiceAuthGroup"."activeProfileId"
  );

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ConnectedServiceAuthGroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupDbId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "stateJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConnectedServiceAuthGroupMember_groupDbId_fkey"
        FOREIGN KEY ("groupDbId") REFERENCES "ConnectedServiceAuthGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_fkey"
        FOREIGN KEY ("accountId", "vendor", "profileId") REFERENCES "ServiceAccountToken" ("accountId", "vendor", "profileId") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_ConnectedServiceAuthGroupMember" (
    "id",
    "groupDbId",
    "accountId",
    "vendor",
    "groupId",
    "profileId",
    "priority",
    "enabled",
    "stateJson",
    "createdAt",
    "updatedAt"
)
SELECT
    "id",
    "groupDbId",
    "accountId",
    "vendor",
    "groupId",
    "profileId",
    "priority",
    "enabled",
    "stateJson",
    "createdAt",
    "updatedAt"
FROM "ConnectedServiceAuthGroupMember";

DROP TABLE "ConnectedServiceAuthGroupMember";
ALTER TABLE "new_ConnectedServiceAuthGroupMember" RENAME TO "ConnectedServiceAuthGroupMember";

CREATE UNIQUE INDEX "ConnectedServiceAuthGroupMember_accountId_vendor_groupId_profileId_key"
ON "ConnectedServiceAuthGroupMember"("accountId", "vendor", "groupId", "profileId");

CREATE INDEX "ConnectedServiceAuthGroupMember_groupDbId_idx"
ON "ConnectedServiceAuthGroupMember"("groupDbId");

CREATE INDEX "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_idx"
ON "ConnectedServiceAuthGroupMember"("accountId", "vendor", "profileId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
