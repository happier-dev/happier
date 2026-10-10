/**
 * Team identity Action ids are dependency-free because the shared Action id
 * registry initializes before Team identity's domain schema graph.
 */
export const TEAM_IDENTITY_ACTION_IDS_V1 = [
  'teams.identity.connections.list',
  'teams.identity.connections.create',
  'teams.identity.connections.settings.update',
  'teams.identity.connections.enable',
  'teams.identity.connections.disable',
  'teams.identity.connections.remove.preview',
  'teams.identity.connections.remove',
  'teams.identity.connections.test.start',
  'teams.identity.connections.test.consume',
  'teams.identity.workos.adminPortalLink.create',
  'teams.identity.workos.connection.create',
  'teams.identity.workos.reconcile',
  'teams.identity.workos.connection.set',
] as const;

export type TeamIdentityActionIdV1 = typeof TEAM_IDENTITY_ACTION_IDS_V1[number];

export const TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1 = [
  'teams.identity.connections.settings.update',
  'teams.identity.connections.enable',
  'teams.identity.connections.disable',
  'teams.identity.connections.remove',
  'teams.identity.connections.test.start',
  'teams.identity.workos.adminPortalLink.create',
  'teams.identity.workos.reconcile',
  'teams.identity.workos.connection.set',
] as const satisfies readonly TeamIdentityActionIdV1[];

export type TeamIdentityConnectionUserActionIdV1 =
  typeof TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1[number];

export const HOME_IDENTITY_ACTION_IDS_V1 = [
  'home.identity.connections.list',
  'home.identity.connections.create',
  'home.identity.connections.settings.update',
  'home.identity.connections.enable',
  'home.identity.connections.disable',
  'home.identity.connections.remove.preview',
  'home.identity.connections.remove',
  'home.identity.connections.test.start',
  'home.identity.connections.test.consume',
  'home.identity.workos.adminPortalLink.create',
  'home.identity.workos.connection.create',
  'home.identity.workos.reconcile',
  'home.identity.workos.connection.set',
] as const;
export type HomeIdentityActionIdV1 = typeof HOME_IDENTITY_ACTION_IDS_V1[number];

export const HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1 = [
  'home.identity.connections.settings.update',
  'home.identity.connections.enable',
  'home.identity.connections.disable',
  'home.identity.connections.remove',
  'home.identity.connections.test.start',
  'home.identity.workos.adminPortalLink.create',
  'home.identity.workos.reconcile',
  'home.identity.workos.connection.set',
] as const satisfies readonly HomeIdentityActionIdV1[];
export type HomeIdentityConnectionUserActionIdV1 = typeof HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1[number];
export type IdentityConnectionUserActionIdV1 = TeamIdentityConnectionUserActionIdV1
  | HomeIdentityConnectionUserActionIdV1;
