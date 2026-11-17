import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationIdV1Schema } from './automationIdV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationSourceSelectorIdV1Schema } from './automationEventJsonBoundsV1.js';

/** Public structural locator shared by native facts and private Event admission. */
export const AutomationEventAdmitDefinitionSelectorV1Schema = lazyZodSchema(() => z.strictObject({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
}));
export type AutomationEventAdmitDefinitionSelectorV1 = z.infer<typeof AutomationEventAdmitDefinitionSelectorV1Schema>;
