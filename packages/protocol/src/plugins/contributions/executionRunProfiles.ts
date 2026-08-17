import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { ExecutionRunIntentSchema } from '../../execution/runs/runPrimitives.js';
import {
  PluginAvailabilityDescriptorV2Schema,
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';

export const PluginExecutionRunProfileActionReferenceV2Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('contributionAction'),
    action: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict(),
  z.object({
    kind: z.literal('hostAction'),
    actionId: z.literal('reviews.comments.create'),
  }).strict(),
]);
export type PluginExecutionRunProfileActionReferenceV2 = z.infer<typeof PluginExecutionRunProfileActionReferenceV2Schema>;

export const PluginExecutionRunProfileContributionV2Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  intent: ExecutionRunIntentSchema,
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  promptAsset: asProtocolZod(PluginContributionReferenceV2Schema),
  defaults: z.object({
    retention: z.enum(['ephemeral', 'resumable']),
    runClass: z.enum(['bounded', 'longLived']),
    io: z.enum(['requestResponse', 'streaming']),
  }).strict(),
  compatibleAgents: z.array(asProtocolZod(PluginContributionReferenceV2Schema)).min(1),
  actions: z.array(PluginExecutionRunProfileActionReferenceV2Schema).optional(),
  availability: PluginAvailabilityDescriptorV2Schema.optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginExecutionRunProfileContributionV2 = z.infer<typeof PluginExecutionRunProfileContributionV2Schema>;
