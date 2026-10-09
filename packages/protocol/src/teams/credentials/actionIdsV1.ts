/** Reachable Team credential-resource intents. Additional plan vocabulary is
 * intentionally not registered until its domain producer and result contract
 * exist. */
export const TEAM_CREDENTIAL_ACTION_IDS_V1 = [
  'teams.credentials.list',
  'teams.credentials.sources.list',
  'teams.credentials.requestPolicySupport.get',
  'teams.credentials.sourceResources.list',
  'teams.credentials.get',
  'teams.credentials.entitled.list',
  'teams.credentials.create',
  'teams.credentials.update',
  'teams.credentials.audience.set',
  'teams.credentials.delete',
  'teams.credentials.test',
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

export type TeamCredentialActionIdV1 = typeof TEAM_CREDENTIAL_ACTION_IDS_V1[number];
