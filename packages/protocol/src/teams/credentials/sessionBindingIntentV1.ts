import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { QualifiedConnectedAccountPurposeV1Schema } from '../../connect/connectedAccountPurposeIdentity.js';
import { TeamCredentialRouteV1Schema } from './resourceV1.js';

export const SessionTeamCredentialProviderModelSlotV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('provider_model'),
}).strict());

export const SessionTeamCredentialConnectedServicePurposeSlotV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('connected_service_purpose'),
  purpose: QualifiedConnectedAccountPurposeV1Schema,
}).strict());

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
  z.object({
    v: z.literal(1), slot: SessionTeamCredentialSlotV1Schema,
    resourceId: z.string().min(1), expectedResourceRevision: z.number().int().nonnegative(),
    deliveryMode: TeamCredentialRouteV1Schema,
    /** Exact Team route for Provider-model bindings; retained inputs may omit it. */
    teamId: z.string().min(1).optional(),
  }).strict(),
  z.object({ v: z.literal(1), slot: SessionTeamCredentialSlotV1Schema, resourceId: z.null() }).strict(),
]));
export type SessionTeamCredentialBindingIntentV1 = z.infer<typeof SessionTeamCredentialBindingIntentV1Schema>;

export function sessionTeamCredentialSlotKeyV1(slot: SessionTeamCredentialSlotV1): string {
  const parsed = SessionTeamCredentialSlotV1Schema.parse(slot);
  return parsed.kind === 'provider_model'
    ? JSON.stringify(['provider_model'])
    : JSON.stringify(['connected_service_purpose', parsed.purpose.consumer.pluginId, parsed.purpose.consumer.localId, parsed.purpose.purpose]);
}

export const SessionTeamCredentialBindingIntentsV1Schema = lazyZodSchema(() => z.array(SessionTeamCredentialBindingIntentV1Schema)
  .superRefine((intents, context) => {
    const seen = new Set<string>();
    for (const [index, intent] of intents.entries()) {
      const key = sessionTeamCredentialSlotKeyV1(intent.slot);
      if (seen.has(key)) context.addIssue({ code: 'custom', path: [index, 'slot'], message: 'Duplicate Session credential slot.' });
      seen.add(key);
    }
  }));

export type SessionTeamCredentialBindingIntentListV1 = z.infer<typeof SessionTeamCredentialBindingIntentsV1Schema>;

export function encodeSessionTeamCredentialSlotKeyV1(slot: SessionTeamCredentialSlotV1): Uint8Array {
  return new TextEncoder().encode(sessionTeamCredentialSlotKeyV1(slot));
}
