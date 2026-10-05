import { z } from 'zod';
import { AutomationDefinitionCreateRequestSchema } from '../../automations/automationApiV3.js';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema } from '../../automations/automationWorkflowRecipeV2.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import { SessionInitialTriggerDefinitionV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';

/** Host-sealed Automation intent, consumed only inside the Session birth transaction. */
export const SessionInitialTriggerAdmissionV1Schema = z.lazy(() => {
  const { scopeSessionId: _birthScope, triggers: _birthTriggers, ...fields } = AutomationDefinitionCreateRequestSchema.shape;
  return z.object({
    ...fields,
    executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema,
    triggers: z.array(z.object({
      triggerId: AutomationTriggerIdSchema,
      trigger: SessionInitialTriggerDefinitionV1Schema,
    }).strict()),
  }).strict();
});
export type SessionInitialTriggerAdmissionV1 = z.infer<typeof SessionInitialTriggerAdmissionV1Schema>;
