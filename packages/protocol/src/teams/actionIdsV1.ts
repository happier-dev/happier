import { TEAM_DIRECTORY_ACTION_IDS_V1 } from './directory/actionIds.js';
import { TEAM_IDENTITY_ACTION_IDS_V1 } from './identity/actionIds.js';
import { TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1 } from './externalGroupBindings/actionIds.js';
import { TEAM_CREDENTIAL_HOME_ACTION_IDS_V1, TEAM_CREDENTIAL_HOST_ACTION_IDS_V1 } from './credentials/actionIdsV1.js';

/** Action identity leaf: schema modules and the registry share these constants. */
export const TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1 = [
  'teams.members.history.preparation.get', 'teams.members.history.prepare',
] as const;
/**
 * The Team intents carried to the Home's native HTTP owners.
 *
 * Like the Home-governance family, this module owns only the vocabulary: each
 * intent's path and strict contract are declared once on its Action row and
 * every lookup derives from there.
 *
 * An id exists exactly when its owner has published the strict input and result
 * the row consumes. Invitation listing, revocation, and reissue are included
 * because their page and outcome shapes now come from the invitation owner;
 * placeholders would still be a second definition of those contracts.
 */
export const TEAM_HOME_ACTION_IDS_V1 = [
  'teams.list',
  'teams.get',
  'teams.create',
  'teams.update',
  'teams.logo.set',
  'teams.logo.remove',
  'teams.policy.set',
  'teams.archive',
  'teams.restore',
  'teams.members.list',
  'teams.members.get',
  'teams.members.add',
  'teams.members.role.set',
  'teams.members.suspend',
  'teams.members.reactivate',
  'teams.members.remove',
  'teams.members.leave',
  'teams.members.management.set',
  'teams.members.groups.list',
  'teams.groups.list',
  'teams.groups.get',
  'teams.groups.create',
  'teams.groups.update',
  'teams.groups.archive',
  'teams.groups.restore',
  'teams.groups.members.list',
  'teams.groups.members.add',
  'teams.groups.members.remove',
  'teams.invitations.list',
  'teams.invitations.create',
  'teams.invitations.revoke',
  'teams.invitations.reissue',
  'teams.invitations.preview',
  'teams.invitations.accept.prepareApproval',
  'teams.invitations.accept',
  ...TEAM_IDENTITY_ACTION_IDS_V1,
  ...TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1,
  ...TEAM_DIRECTORY_ACTION_IDS_V1,
  ...TEAM_CREDENTIAL_HOME_ACTION_IDS_V1,
] as const;
export const TEAM_ACTION_IDS_V1 = [
  ...TEAM_HOME_ACTION_IDS_V1,
  ...TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1,
  ...TEAM_CREDENTIAL_HOST_ACTION_IDS_V1,
] as const;
