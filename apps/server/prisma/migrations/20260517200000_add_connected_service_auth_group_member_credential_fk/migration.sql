DELETE FROM "ConnectedServiceAuthGroupMember" AS member
WHERE NOT EXISTS (
    SELECT 1
    FROM "ServiceAccountToken" AS credential
    WHERE credential."accountId" = member."accountId"
      AND credential."vendor" = member."vendor"
      AND credential."profileId" = member."profileId"
);

UPDATE "ConnectedServiceAuthGroup" AS auth_group
SET
    "activeProfileId" = NULL,
    "generation" = "generation" + 1
WHERE auth_group."activeProfileId" IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM "ServiceAccountToken" AS credential
      WHERE credential."accountId" = auth_group."accountId"
        AND credential."vendor" = auth_group."vendor"
        AND credential."profileId" = auth_group."activeProfileId"
  );

ALTER TABLE "ConnectedServiceAuthGroupMember"
ADD CONSTRAINT "ConnectedServiceAuthGroupMember_accountId_vendor_profileId_fkey"
FOREIGN KEY ("accountId", "vendor", "profileId")
REFERENCES "ServiceAccountToken"("accountId", "vendor", "profileId")
ON DELETE CASCADE
ON UPDATE CASCADE;
