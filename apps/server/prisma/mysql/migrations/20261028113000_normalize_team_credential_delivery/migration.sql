-- Exact confirmation records include source/Agent/model fingerprints and do
-- not fit the former 191-character enum-storage column.
ALTER TABLE `TeamCredentialResource` MODIFY `disclosureCeiling` LONGTEXT NOT NULL;

ALTER TABLE `SessionTeamCredentialBinding`
  ADD COLUMN `nativeManagedId` VARCHAR(191) NULL,
  ADD COLUMN `nativeDeliveryJson` LONGTEXT NULL;

CREATE INDEX `STCB_native_managed_idx` ON `SessionTeamCredentialBinding`(`nativeManagedId`);

-- Preserve dormant custodian consent independently of enablement, audience,
-- broker placement and readiness. Native is always an explicit later opt-in.
UPDATE `TeamCredentialResource` SET `disclosureCeiling` = CASE `disclosureCeiling`
  WHEN 'brokered_only' THEN '{"policy":{"preferredAllowedModes":["brokered"]},"experimentalBindingConfirmations":[]}'
  WHEN 'direct_allowed' THEN '{"policy":{"preferredAllowedModes":["brokered","direct"]},"experimentalBindingConfirmations":[]}'
END WHERE `disclosureCeiling` IN ('brokered_only', 'direct_allowed');

UPDATE `TeamCredentialResource` SET `allMembersDeliveryMode` = CASE `allMembersDeliveryMode`
  WHEN 'brokered' THEN '["brokered"]'
  WHEN 'direct' THEN '["direct"]'
  WHEN 'both' THEN '["brokered","direct"]'
END WHERE `allMembersDeliveryMode` IN ('brokered', 'direct', 'both');

UPDATE `TeamCredentialGroupGrant` SET `deliveryMode` = CASE `deliveryMode`
  WHEN 'brokered' THEN '["brokered"]'
  WHEN 'direct' THEN '["direct"]'
  WHEN 'both' THEN '["brokered","direct"]'
END WHERE `deliveryMode` IN ('brokered', 'direct', 'both');

UPDATE `TeamCredentialMemberGrant` SET `deliveryMode` = CASE `deliveryMode`
  WHEN 'brokered' THEN '["brokered"]'
  WHEN 'direct' THEN '["direct"]'
  WHEN 'both' THEN '["brokered","direct"]'
END WHERE `deliveryMode` IN ('brokered', 'direct', 'both');
