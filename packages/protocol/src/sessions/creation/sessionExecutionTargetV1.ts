import { z } from 'zod';

import { SESSION_ORGANIZATION_MAX_ID_LENGTH } from '../organization/constants.js';

/**
 * Opaque creation-scoped identifiers share one bounded string grammar across
 * execution targets and creation-time organization placement.
 */
export const SessionCreationOpaqueIdV1Schema = z.string()
  .trim()
  .min(1)
  .max(SESSION_ORGANIZATION_MAX_ID_LENGTH);

/**
 * The server-qualified daemon target selected before Session creation. Display
 * labels and host names are intentionally not part of this identity.
 */
export const SessionExecutionTargetV1Schema = z.object({
  serverId: SessionCreationOpaqueIdV1Schema,
  machineId: SessionCreationOpaqueIdV1Schema,
}).strict();
export type SessionExecutionTargetV1 = z.infer<typeof SessionExecutionTargetV1Schema>;
