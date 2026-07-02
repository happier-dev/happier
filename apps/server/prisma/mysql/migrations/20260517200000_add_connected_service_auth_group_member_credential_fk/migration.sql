DELETE member
FROM `ConnectedServiceAuthGroupMember` AS member
LEFT JOIN `ServiceAccountToken` AS credential
    ON credential.`accountId` = member.`accountId`
   AND credential.`vendor` = member.`vendor`
   AND credential.`profileId` = member.`profileId`
WHERE credential.`id` IS NULL;

UPDATE `ConnectedServiceAuthGroup` AS auth_group
LEFT JOIN `ServiceAccountToken` AS credential
    ON credential.`accountId` = auth_group.`accountId`
   AND credential.`vendor` = auth_group.`vendor`
   AND credential.`profileId` = auth_group.`activeProfileId`
SET
    auth_group.`activeProfileId` = NULL,
    auth_group.`generation` = auth_group.`generation` + 1
WHERE auth_group.`activeProfileId` IS NOT NULL
  AND credential.`id` IS NULL;

ALTER TABLE `ConnectedServiceAuthGroupMember`
ADD CONSTRAINT `ConnectedServiceAuthGroupMember_accountId_vendor_profileId_fkey`
FOREIGN KEY (`accountId`, `vendor`, `profileId`)
REFERENCES `ServiceAccountToken`(`accountId`, `vendor`, `profileId`)
ON DELETE CASCADE
ON UPDATE CASCADE;
