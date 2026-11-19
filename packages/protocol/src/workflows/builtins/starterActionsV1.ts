import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { WorkflowDefinitionV1Schema } from '../workflowV1.js';
import { AutomationScheduleTriggerInputSchema, AutomationSessionLifecycleAuthoredTriggerInputSchema, AutomationTriggerDefinitionInputSchema } from '../../automations/automationTriggerDefinition.js';
import { AutomationSessionSubjectV1Schema } from '../../automations/automationSubjectV1.js';
import { PluginUiOpenAutomationEventRequestV1Schema } from '../../plugins/ui/hostApiRequests.js';
import { WORKFLOW_STARTER_EXAMPLE_KEYS_V1 } from './examples.js';

export const WorkflowStarterSessionTargetV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)),
  serverId: z.optional(AutomationSessionSubjectV1Schema.shape.serverId),
}));
export const WorkflowStarterExampleV1Schema = lazyZodSchema(() => z.strictObject({
  key: z.enum(WORKFLOW_STARTER_EXAMPLE_KEYS_V1), titleKey: z.string().check(z.minLength(1)), descriptionKey: z.string().check(z.minLength(1)),
  definition: WorkflowDefinitionV1Schema,
  eventSeed: z.optional(PluginUiOpenAutomationEventRequestV1Schema),
  triggerSeed: z.optional(z.union([AutomationScheduleTriggerInputSchema,
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(AutomationSessionLifecycleAuthoredTriggerInputSchema, { subject: true }))])),
}));
export const WorkflowStartersListInputV1Schema = lazyZodSchema(() => z.strictObject({}));
export const WorkflowStartersListResultV1Schema = lazyZodSchema(() => z.strictObject({
  examples: z.array(WorkflowStarterExampleV1Schema),
}));
export const WorkflowStartersResolveInputV1Schema = lazyZodSchema(() => z.strictObject({
  key: z.enum(WORKFLOW_STARTER_EXAMPLE_KEYS_V1),
  session: z.optional(WorkflowStarterSessionTargetV1Schema), timezone: z.optional(z.nullable(z.string())),
}));
export const WorkflowStartersResolveResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('requires_session') }),
  z.strictObject({ status: z.literal('ready'), example: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WorkflowStarterExampleV1Schema, {
    trigger: z.optional(AutomationTriggerDefinitionInputSchema), sessionTarget: z.optional(WorkflowStarterSessionTargetV1Schema),
  })) }),
]));
