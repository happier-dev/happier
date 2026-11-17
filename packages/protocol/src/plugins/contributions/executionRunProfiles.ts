import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { ExecutionRunIntentSchema } from '../../execution/runs/runPrimitives.js';
import { isRecursivelyClosedPluginJsonSchemaV2 } from './jsonSchema.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginJsonSchemaV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';

export const PluginExecutionRunProfileActionReferenceV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('contributionAction'),
    action: asProtocolZod(PluginContributionReferenceV2Schema),
  }),
  z.strictObject({
    kind: z.literal('hostAction'),
    actionId: z.literal('reviews.comments.create'),
  }),
]));
export type PluginExecutionRunProfileActionReferenceV2 = z.infer<typeof PluginExecutionRunProfileActionReferenceV2Schema>;

export const PluginExecutionRunProfileContributionV2Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  intent: ExecutionRunIntentSchema,
  title: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  promptAsset: asProtocolZod(PluginContributionReferenceV2Schema),
  defaults: z.strictObject({
    retention: z.enum(['ephemeral', 'resumable']),
    runClass: z.enum(['bounded', 'longLived']),
    io: z.enum(['requestResponse', 'streaming']),
  }),
  compatibleAgents: z.array(asProtocolZod(PluginContributionReferenceV2Schema)).check(z.minLength(1)),
  actions: z.optional(z.array(PluginExecutionRunProfileActionReferenceV2Schema)),
  optionsSchema: z.optional(PluginJsonSchemaV2Schema.check(z.refine(
    (schema) => schema.type === 'object' && isRecursivelyClosedPluginJsonSchemaV2(schema),
    'Execution-run options must declare a recursively closed object schema',
  ))),
  availability: z.optional(PluginAvailabilityDescriptorV2Schema),
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}));
export type PluginExecutionRunProfileContributionV2 = z.infer<typeof PluginExecutionRunProfileContributionV2Schema>;
