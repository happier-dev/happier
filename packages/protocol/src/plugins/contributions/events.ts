import { z } from 'zod';

import { PluginEventAutomationDeclarationV1Schema } from '../../automations/automationEventDeclarationV1.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginContributionReferenceV2Schema,
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import {
  AutomationHostEventTargetV1Schema,
  HOST_EVENT_IDS_V1,
  RuntimeHostEventTargetV1Schema,
} from '../events/hostReferencesV1.js';

const PluginContributionLocalIdZodSchema = asProtocolZod(PluginContributionLocalIdSchema);
const PluginContributionReferenceV2ZodSchema = asProtocolZod(PluginContributionReferenceV2Schema);
const RESERVED_HOST_EVENT_IDS_V1 = new Set<string>(HOST_EVENT_IDS_V1);

const ReservedRuntimeEventIdSchema = PluginContributionLocalIdZodSchema.refine(
  (id) => !RESERVED_HOST_EVENT_IDS_V1.has(`@happier/runtime/${id}`),
  'Plugin events cannot use canonical agent runtime event ids',
);

const HostEventSubscriptionTargetV1Schema = z.union([
  RuntimeHostEventTargetV1Schema.extend({
    kind: z.literal('host'),
  }),
  AutomationHostEventTargetV1Schema.extend({
    kind: z.literal('host'),
  }),
]);

export const EventSubscriptionTargetV1Schema = z.union([
  z.object({
    kind: z.literal('plugin'),
    event: PluginContributionReferenceV2ZodSchema,
  }).strict(),
  HostEventSubscriptionTargetV1Schema,
]);
export type EventSubscriptionTargetV1 = z.input<typeof EventSubscriptionTargetV1Schema>;

export const PluginEventContributionV1Schema = z.discriminatedUnion('kind', [
  z.object({
    id: ReservedRuntimeEventIdSchema,
    kind: z.literal('event'),
    title: PluginLocalizedStringV2Schema,
    description: PluginLocalizedStringV2Schema.optional(),
    payloadSchema: PluginJsonSchemaV2Schema.optional(),
    automation: PluginEventAutomationDeclarationV1Schema.optional(),
    metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  }).strict(),
  z.object({
    id: PluginContributionLocalIdZodSchema,
    kind: z.literal('subscription'),
    target: EventSubscriptionTargetV1Schema,
    filterSchema: PluginJsonSchemaV2Schema.optional(),
    priority: z.number().int().optional(),
    metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
  }).strict(),
]);
export type PluginEventContributionV1 = z.input<typeof PluginEventContributionV1Schema>;
export type ParsedPluginEventContributionV1 = z.output<typeof PluginEventContributionV1Schema>;
