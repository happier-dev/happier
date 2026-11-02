import { ProviderAgentTargetKeySchema } from '../../providers/ids.js';
import { ProviderModelIdSchema } from '../../providers/ids.js';
import { ProviderBrokerApplicationBindingV1Schema } from '../../providers/brokerRouteGrantV1.js';
import { ProviderMachineIdSchema } from '../../providers/ids.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { TeamCredentialRouteV1Schema } from './resourceV1.js';

export const SessionTeamCredentialProviderModelSlotV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('provider_model'),
}));

export const SessionTeamCredentialConnectedServicePurposeSlotV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('connected_service_purpose'),
  purpose: QualifiedConnectedAccountPurposeV1Schema,
}));

export const SessionTeamCredentialSlotV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionTeamCredentialProviderModelSlotV1Schema,
  SessionTeamCredentialConnectedServicePurposeSlotV1Schema,
]));

export type SessionTeamCredentialSlotV1 = z.infer<typeof SessionTeamCredentialSlotV1Schema>;

/**
 * Browser-safe fresh-Session credential selection. The existing-Session
 * mutation contract lives in `sessionBindingV1.ts` because it additionally
 * carries the owner-metadata patch and its runtime crypto implementation.
 */
export const SessionTeamCredentialBindingIntentV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    v: z.literal(1), slot: SessionTeamCredentialSlotV1Schema,
    resourceId: z.string().check(z.minLength(1)), expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
    deliveryMode: TeamCredentialRouteV1Schema,
    /** Exact Team route for Provider-model bindings; retained inputs may omit it. */
    teamId: z.optional(z.string().check(z.minLength(1))),
  }),
  z.strictObject({ v: z.literal(1), slot: SessionTeamCredentialSlotV1Schema, resourceId: z.null() }),
]));
export type SessionTeamCredentialBindingIntentV1 = z.infer<typeof SessionTeamCredentialBindingIntentV1Schema>;

export function sessionTeamCredentialSlotKeyV1(slot: SessionTeamCredentialSlotV1): string {
  const parsed = SessionTeamCredentialSlotV1Schema.parse(slot);
  return parsed.kind === 'provider_model'
    ? JSON.stringify(['provider_model'])
    : JSON.stringify(['connected_service_purpose', parsed.purpose.consumer.pluginId, parsed.purpose.consumer.localId, parsed.purpose.purpose]);
}

export const SessionTeamCredentialBindingIntentsV1Schema = lazyZodSchema(() => z.array(SessionTeamCredentialBindingIntentV1Schema).check(z.superRefine((intents, context) => {
    const seen = new Set<string>();
    for (const [index, intent] of intents.entries()) {
      const key = sessionTeamCredentialSlotKeyV1(intent.slot);
      if (seen.has(key)) context.addIssue({ code: 'custom', path: [index, 'slot'], message: 'Duplicate Session credential slot.' });
      seen.add(key);
    }
  })));

export type SessionTeamCredentialBindingIntentListV1 = z.infer<typeof SessionTeamCredentialBindingIntentsV1Schema>;

export function encodeSessionTeamCredentialSlotKeyV1(slot: SessionTeamCredentialSlotV1): Uint8Array {
  return new TextEncoder().encode(sessionTeamCredentialSlotKeyV1(slot));
}

export const SessionTeamCredentialNativeDeliveryV1Schema = lazyZodSchema(() => z.strictObject({
  managedId: z.string().check(z.minLength(1)),
  controllerInstallationId: z.string().check(z.minLength(1)),
  guestInstallationId: z.string().check(z.minLength(1)),
  bindingKey: z.string().check(z.minLength(1)),
  placeholderRef: z.string().check(z.minLength(1)),
  sourceRevision: z.string().check(z.minLength(1), z.maxLength(512)),
  providerTicket: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
}));

export const SessionTeamCredentialProviderModelSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
  application: z.optional(ProviderBrokerApplicationBindingV1Schema),
  executionMachineId: z.optional(ProviderMachineIdSchema),
  nativeSource: z.optional(SessionTeamCredentialNativeSourceV1Schema),
}).check(z.superRefine((selection, context) => {
  if (selection.application && selection.application.agentTargetKey !== selection.agentTargetKey) {
    context.addIssue({ code: 'custom', path: ['application'], message: 'Application must match the selected Agent target' });
  }
  if ((selection.application === undefined) !== (selection.executionMachineId === undefined)) {
    context.addIssue({ code: 'custom', message: 'Application and execution Machine must be accepted together' });
  }
})));

export const SessionTeamCredentialNativeSourceV1Schema = lazyZodSchema(() => z.strictObject({
  sourceRevision: z.string().check(z.minLength(1), z.maxLength(512)),
  providerTicket: SessionTeamCredentialNativeDeliveryV1Schema.shape.providerTicket,
}));
