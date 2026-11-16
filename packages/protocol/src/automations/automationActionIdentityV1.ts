import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionIdSchema } from '../actions/actionIds.js';
import { parseQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';

/** Action routing identities remain independent of private subject definitions. */
export const AutomationTriggerActionIdV1Schema = lazyZodSchema(() => z.union([
  ActionIdSchema,
  z.string().check(z.refine(value => parseQualifiedPluginActionId(value) !== null)),
]));
export const AutomationActionPhaseV1Schema = lazyZodSchema(() => z.enum(['before', 'after']));
