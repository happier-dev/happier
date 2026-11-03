import { z } from 'zod/mini';
import { AutomationExecutionDefinitionCreateRequestSchema } from '../../automations/automationApiV3.js';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema } from '../../automations/automationWorkflowRecipeV2.js';
import { AutomationTriggerIdSchema } from '../../automations/automationTriggerIdentity.js';
import { SessionInitialTriggerDefinitionV1Schema } from '../../workflows/triggers/workflowTriggerActionsV1.js';

/** Host-sealed Automation intent, consumed only inside the Session birth transaction. */
export const SessionInitialTriggerAdmissionV1Schema = z.lazy(() => {
  const { scopeSessionId: _birthScope, triggers: _birthTriggers, ...fields } = AutomationExecutionDefinitionCreateRequestSchema.shape;
  return z.strictObject({
    ...fields,
    executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema,
    triggers: z.array(z.strictObject({
      triggerId: AutomationTriggerIdSchema,
      trigger: SessionInitialTriggerDefinitionV1Schema,
    })),
  });
});
export type SessionInitialTriggerAdmissionV1 = z.infer<typeof SessionInitialTriggerAdmissionV1Schema>;
