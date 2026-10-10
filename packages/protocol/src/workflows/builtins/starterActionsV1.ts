import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { WorkflowDefinitionV1Schema } from '../workflowV1.js';
import { AutomationScheduleTriggerInputSchema, AutomationSessionLifecycleTriggerInputSchema, AutomationTriggerDefinitionInputSchema } from '../../automations/automationTriggerDefinition.js';
import { WORKFLOW_STARTER_EXAMPLE_KEYS_V1 } from './examples.js';

export const WorkflowStarterSessionTargetV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1), machineId: z.string().min(1),
}).strict());
export const WorkflowStarterExampleV1Schema = lazyZodSchema(() => z.object({
  key: z.enum(WORKFLOW_STARTER_EXAMPLE_KEYS_V1), titleKey: z.string().min(1), descriptionKey: z.string().min(1),
  definition: WorkflowDefinitionV1Schema,
  triggerSeed: z.union([AutomationScheduleTriggerInputSchema,
    AutomationSessionLifecycleTriggerInputSchema.omit({ sourceSessionId: true }).strict()]).optional(),
}).strict());
export const WorkflowStartersListInputV1Schema = lazyZodSchema(() => z.object({}).strict());
export const WorkflowStartersListResultV1Schema = lazyZodSchema(() => z.object({
  examples: z.array(WorkflowStarterExampleV1Schema),
}).strict());
export const WorkflowStartersResolveInputV1Schema = lazyZodSchema(() => z.object({
  key: z.enum(WORKFLOW_STARTER_EXAMPLE_KEYS_V1),
  session: WorkflowStarterSessionTargetV1Schema.optional(), timezone: z.string().nullable().optional(),
}).strict());
export const WorkflowStartersResolveResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('requires_session') }).strict(),
  z.object({ status: z.literal('ready'), example: WorkflowStarterExampleV1Schema.extend({
    trigger: AutomationTriggerDefinitionInputSchema.optional(), sessionTarget: WorkflowStarterSessionTargetV1Schema.optional(),
  }).strict() }).strict(),
]));
