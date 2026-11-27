import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

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

const ReservedRuntimeEventIdSchema = lazyZodSchema(() => PluginContributionLocalIdZodSchema.check(zMini.refine((id) => !RESERVED_HOST_EVENT_IDS_V1.has(`@happier/runtime/${id}`), 'Plugin events cannot use canonical agent runtime event ids')));

const HostEventSubscriptionTargetV1Schema = lazyZodSchema(() => z.union([
  zMini.extend(RuntimeHostEventTargetV1Schema, {
    kind: z.literal('host'),
  }),
  zMini.extend(AutomationHostEventTargetV1Schema, {
    kind: z.literal('host'),
  }),
]));

export const EventSubscriptionTargetV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('plugin'),
    event: PluginContributionReferenceV2ZodSchema,
    optional: z.optional(z.literal(true)),
  }),
  HostEventSubscriptionTargetV1Schema,
]));
export type EventSubscriptionTargetV1 = z.input<typeof EventSubscriptionTargetV1Schema>;

export const PluginEventContributionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    id: ReservedRuntimeEventIdSchema,
    kind: z.literal('event'),
    title: PluginLocalizedStringV2Schema,
    description: zMini.optional(PluginLocalizedStringV2Schema),
    payloadSchema: zMini.optional(PluginJsonSchemaV2Schema),
    automation: zMini.optional(PluginEventAutomationDeclarationV1Schema),
    metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
  }).check(z.superRefine((value, context) => {
    // An Automation authors filters, payload mappings and run inputs against
    // the Event payload. Admitting an eligible Event with no published payload
    // contract offers the author a source whose occurrences have no describable
    // shape, so eligibility and the payload contract are declared together.
    if (value.automation !== undefined && value.payloadSchema === undefined) {
      context.addIssue({
        code: "custom",
        path: ['payloadSchema'],
        message: 'An Automation-eligible Event must publish a payload schema',
      });
    }
  })),
  z.strictObject({
    id: PluginContributionLocalIdZodSchema,
    kind: z.literal('subscription'),
    target: EventSubscriptionTargetV1Schema,
    filterSchema: zMini.optional(PluginJsonSchemaV2Schema),
    priority: z.optional(z.number().check(z.int())),
    metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
  }),
]));
export type PluginEventContributionV1 = z.input<typeof PluginEventContributionV1Schema>;
export type ParsedPluginEventContributionV1 = z.output<typeof PluginEventContributionV1Schema>;

type DeclaredEventV1 = Extract<ParsedPluginEventContributionV1, { kind: 'event' }>;
export type AutomationEligibleEventContributionV1 = Readonly<Omit<DeclaredEventV1, 'automation'> & {
  automation: NonNullable<DeclaredEventV1['automation']>;
}>;

/** The admitted declaration owns Event identity, Automation eligibility and source-contract version. */
export function readAutomationEligibleEventContributionV1(params: Readonly<{
  events: readonly ParsedPluginEventContributionV1[];
  eventLocalId: string;
  sourceContractVersion?: number;
}>): AutomationEligibleEventContributionV1 | null {
  const event = params.events.find((candidate): candidate is DeclaredEventV1 =>
    candidate.kind === 'event' && candidate.id === params.eventLocalId);
  const automation = event?.automation;
  if (!event || !automation || automation.eligible !== true
    || (params.sourceContractVersion !== undefined
      && automation.source.sourceContractVersion !== params.sourceContractVersion)) return null;
  return { ...event, automation };
}
