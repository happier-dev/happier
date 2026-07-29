import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginContributionReferenceV2Schema,
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import { AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 } from '../../runtime/agentSessionV1.js';

const ReservedRuntimeEventIdSchema = PluginContributionLocalIdSchema.refine(
  (id) => !(AGENT_SESSION_RUNTIME_EVENT_KINDS_V1 as readonly string[]).includes(id),
  'Plugin events cannot use canonical agent runtime event ids',
);

export const PluginEventContributionV1Schema = z.discriminatedUnion('kind', [
  z.object({
    id: ReservedRuntimeEventIdSchema,
    kind: z.literal('event'),
    title: PluginLocalizedStringV2Schema,
    description: PluginLocalizedStringV2Schema.optional(),
    payloadSchema: PluginJsonSchemaV2Schema.optional(),
    metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  }).strict(),
  z.object({
    id: PluginContributionLocalIdSchema,
    kind: z.literal('subscription'),
    event: PluginContributionReferenceV2Schema,
    filterSchema: PluginJsonSchemaV2Schema.optional(),
    priority: z.number().int().optional(),
    metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  }).strict(),
]);
export type PluginEventContributionV1 = z.input<typeof PluginEventContributionV1Schema>;
export type ParsedPluginEventContributionV1 = z.output<typeof PluginEventContributionV1Schema>;
