import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from '../organization/constants.js';

/**
 * Opaque creation-scoped identifiers share one bounded string grammar across
 * execution targets and creation-time organization placement.
 */
export const SessionCreationOpaqueIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(SESSION_ORGANIZATION_MAX_ID_LENGTH)));

/**
 * The server-qualified daemon target selected before Session creation. Display
 * labels and host names are intentionally not part of this identity.
 */
export const SessionExecutionTargetV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: SessionCreationOpaqueIdV1Schema,
  machineId: SessionCreationOpaqueIdV1Schema,
}));
export type SessionExecutionTargetV1 = z.infer<typeof SessionExecutionTargetV1Schema>;
