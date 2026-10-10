import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { TEAM_DIRECTORY_ACTION_IDS_V1 } from './directory/actionIds.js';
import { TEAM_IDENTITY_ACTION_IDS_V1 } from './identity/actionIds.js';
import { TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1 } from './externalGroupBindings/actionIds.js';
import { TEAM_CREDENTIAL_ACTION_IDS_V1 } from './credentials/actionIdsV1.js';

export {
  TEAM_DIRECTORY_ACTION_IDS_V1,
  type TeamDirectoryActionIdV1,
} from './directory/actionIds.js';
export {
  TEAM_IDENTITY_ACTION_IDS_V1,
  TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1,
  type TeamIdentityConnectionUserActionIdV1,
  type TeamIdentityActionIdV1,
} from './identity/actionIds.js';


/**
 * The Team intents this Home serves.
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
export const TEAM_ACTION_IDS_V1 = [
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
  ...TEAM_CREDENTIAL_ACTION_IDS_V1,
] as const;

export type TeamActionIdV1 = typeof TEAM_ACTION_IDS_V1[number];

export const TeamActionIdV1Schema = lazyZodSchema(() => z.enum(TEAM_ACTION_IDS_V1));
