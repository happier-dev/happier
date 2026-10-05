/** Closed configuration vocabulary, independent of payload and Account encryption schemas. */
export const CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 = [
  'connectedServices.accounts.rename',
  'connectedServices.accounts.default.set',
  'connectedServices.pools.create',
  'connectedServices.pools.patch',
  'connectedServices.pools.delete',
  'connectedServices.pools.members.add',
  'connectedServices.pools.members.patch',
  'connectedServices.pools.members.remove',
  'connectedServices.pools.switchNow',
  'connectedServices.pools.reorder',
  'connectedServices.pools.default.set',
  'connectedServices.quota.reset',
  'connectedServices.quota.refresh',
  'connectedServices.identityPrivacy.set',
] as const;
