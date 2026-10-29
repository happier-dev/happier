import { HOME_GOVERNANCE_ACTION_IDS_V1 } from './actionIdsV1.js';
export { HOME_GOVERNANCE_ACTION_IDS_V1 } from './actionIdsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

export type HomeGovernanceActionIdV1 = typeof HOME_GOVERNANCE_ACTION_IDS_V1[number];

export const HomeGovernanceActionIdV1Schema = lazyZodSchema(() => z.enum(HOME_GOVERNANCE_ACTION_IDS_V1));

/**
 * `home.governance.get` takes no arguments: the Home and the viewer both come
 * from the authenticated request, never from caller-supplied input.
 */
export const HomeGovernanceGetInputV1Schema = lazyZodSchema(() => z.strictObject({}));

/**
 * The minimum eligibility read is intentionally a distinct strict contract:
 * ordinary members must never receive the administrative projection and then
 * rely on a client to discard its policy and deployment facts.
 */
export const HomeGovernanceEligibilityGetInputV1Schema = lazyZodSchema(() => z.strictObject({}));

/** The authenticated Home and owner are selected by the request, never by caller input. */
export const HomeEmptinessGetInputV1Schema = lazyZodSchema(() => z.strictObject({}));
