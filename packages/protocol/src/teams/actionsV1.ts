import { TEAM_ACTION_IDS_V1 } from './actionIdsV1.js';
export { TEAM_ACTION_IDS_V1, TEAM_MEMBERSHIP_HISTORY_ACTION_IDS_V1, TEAM_HOME_ACTION_IDS_V1 } from './actionIdsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { TEAM_DIRECTORY_ACTION_IDS_V1 } from './directory/actionIds.js';
import { TEAM_IDENTITY_ACTION_IDS_V1 } from './identity/actionIds.js';
import { TEAM_EXTERNAL_GROUP_BINDING_ACTION_IDS_V1 } from './externalGroupBindings/actionIds.js';
import { TEAM_CREDENTIAL_HOME_ACTION_IDS_V1, TEAM_CREDENTIAL_HOST_ACTION_IDS_V1 } from './credentials/actionIdsV1.js';


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




export type TeamActionIdV1 = typeof TEAM_ACTION_IDS_V1[number];

export const TeamActionIdV1Schema = lazyZodSchema(() => z.enum(TEAM_ACTION_IDS_V1));
