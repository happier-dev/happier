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

/** Shared safe terminal outcome; native producer declarations map their domain state once. */
export const AutomationActionOutcomeV1Schema = lazyZodSchema(() => z.enum(['succeeded', 'failed', 'cancelled', 'outcome_unknown']));
export type AutomationActionOutcomeV1 = z.infer<typeof AutomationActionOutcomeV1Schema>;
