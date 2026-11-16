export const TEAM_CREDENTIAL_CREATE_ACTION_ID_V1 = 'teams.credentials.create';

/** Reachable Team credential-resource intents. Additional plan vocabulary is
 * intentionally not registered until its domain producer and result contract
 * exist. */
export const TEAM_CREDENTIAL_HOME_ACTION_IDS_V1 = [
  'teams.credentials.list',
  'teams.credentials.sources.list',
  'teams.credentials.requestPolicySupport.get',
  'teams.credentials.sourceResources.list',
  'teams.credentials.get',
  'teams.credentials.entitled.list',
  TEAM_CREDENTIAL_CREATE_ACTION_ID_V1,
  'teams.credentials.update',
  'teams.credentials.audience.set',
  'teams.credentials.delete',
  'teams.credentials.test',
  'teams.credentials.preparation.get',
  'teams.credentials.activity.list',
  'teams.credentials.limits.list',
  'teams.credentials.limits.upsert',
  'teams.credentials.limits.delete',
  'teams.credentials.usage.query',
  'teams.credentials.externalKeys.create',
  'teams.credentials.externalKeys.authorize',
  'teams.credentials.externalKeys.list',
  'teams.credentials.externalKeys.revoke',
  'teams.credentials.externalKeys.revokeAll',
] as const;

export type TeamCredentialHomeActionIdV1 = typeof TEAM_CREDENTIAL_HOME_ACTION_IDS_V1[number];

/** Host serialization consumes Home reads without publishing another HTTP operation. */
export const TEAM_CREDENTIAL_HOST_ACTION_IDS_V1 = ['teams.credentials.usage.export'] as const;
export const TEAM_CREDENTIAL_ACTION_IDS_V1 = [
  ...TEAM_CREDENTIAL_HOME_ACTION_IDS_V1,
  ...TEAM_CREDENTIAL_HOST_ACTION_IDS_V1,
] as const;
export type TeamCredentialActionIdV1 = typeof TEAM_CREDENTIAL_ACTION_IDS_V1[number];
