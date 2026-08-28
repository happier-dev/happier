import { z } from 'zod';

import { SessionIdSchema } from '../sessions/idsV1.js';
import { PluginDomainChangeEntrySchema } from './pluginDomain.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

export {
  PluginDomainAvailabilityChangeHintSchema,
  PluginDomainChangeEntrySchema,
  PluginDomainChangeHintSchema,
  PluginDomainDataCollectionChangeHintSchema,
  PluginDomainDataKvChangeHintSchema,
  PluginDomainSettingsChangeHintSchema,
  PluginDomainWebhookChangeHintSchema,
  buildPluginDomainAccountChangeEntityId,
  type PluginDomainAvailabilityChangeHint,
  type PluginDomainChangeEntry,
  type PluginDomainChangeHint,
  type PluginDomainDataCollectionChangeHint,
  type PluginDomainDataKvChangeHint,
  type PluginDomainSettingsChangeHint,
  type PluginDomainWebhookChangeHint,
} from './pluginDomain.js';

export const ChangeKindSchema = z.enum([
  'account',
  'automation',
  'artifact',
  'feed',
  'friends',
  'friend_request',
  'friend_accepted',
  'kv',
  'machine',
  'pet',
  'pluginDomain',
  'session',
  'share',
]);

export type ChangeKind = z.infer<typeof ChangeKindSchema>;

export const ChangeEntrySchema = z.object({
  cursor: z.number().int().min(0),
  kind: z.string().trim().min(1),
  entityId: z.string(),
  changedAt: z.number().int().min(0),
  hint: z.unknown().nullable().optional(),
}).strict().superRefine((entry, context) => {
  if (entry.kind !== 'pluginDomain') return;
  const parsed = PluginDomainChangeEntrySchema.safeParse(entry);
  if (!parsed.success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid pluginDomain AccountChange entry.',
    });
  }
});

export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

/**
 * Durable Account-change fact emitted only after the Server has committed the
 * physical Session deletion. Ordinary Account-relative unavailability (for
 * example share revocation) deliberately carries no such hint.
 */
export const SessionDeletedChangeHintV1Schema = z.object({
  v: z.literal(1),
  lifecycle: z.literal('deleted'),
}).strict();

export type SessionDeletedChangeHintV1 = z.infer<
  typeof SessionDeletedChangeHintV1Schema
>;

const ChangeSessionIdSchema = asProtocolZod(SessionIdSchema);

export function readAuthoritativeSessionDeletionChangeV1(
  value: unknown,
): Readonly<{ sessionId: string; cursor: number }> | null {
  const entry = ChangeEntrySchema.safeParse(value);
  if (!entry.success || entry.data.kind !== 'session') return null;
  const sessionId = ChangeSessionIdSchema.safeParse(entry.data.entityId);
  if (
    !sessionId.success
    || !SessionDeletedChangeHintV1Schema.safeParse(entry.data.hint).success
  ) {
    return null;
  }
  return Object.freeze({
    sessionId: sessionId.data,
    cursor: entry.data.cursor,
  });
}

export const SessionAccessWitnessStatusV1Schema = z.enum([
  'available',
  'unavailable',
]);

export type SessionAccessWitnessStatusV1 = z.infer<
  typeof SessionAccessWitnessStatusV1Schema
>;

export const SessionAccessWitnessEntryV1Schema = z.object({
  sessionId: z.string().trim().min(1),
  cursor: z.number().int().min(0),
  status: SessionAccessWitnessStatusV1Schema,
}).strict();

export type SessionAccessWitnessEntryV1 = z.infer<
  typeof SessionAccessWitnessEntryV1Schema
>;

/**
 * Account-change pages carry this additive proof when the server can attest
 * the current Account-scoped access state of every Session change on the
 * page. It is intentionally optional for supported older servers; callers
 * decide which scoped operation must fail closed when it is absent.
 */
export const SessionAccessWitnessV1Schema = z.object({
  v: z.literal(1),
  throughCursor: z.number().int().min(0),
  entries: z.array(SessionAccessWitnessEntryV1Schema).max(500),
}).strict().superRefine((witness, context) => {
  const sessionIds = new Set<string>();
  for (const entry of witness.entries) {
    if (entry.cursor > witness.throughCursor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Session access witness entry exceeds its captured cursor.',
      });
    }
    if (sessionIds.has(entry.sessionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Session access witness has duplicate Session entries.',
      });
    }
    sessionIds.add(entry.sessionId);
  }
});

export type SessionAccessWitnessV1 = z.infer<typeof SessionAccessWitnessV1Schema>;

/**
 * Host-private, one-Session access proof returned by the incumbent Account
 * change carrier. Callers use it for admission only and never acknowledge its
 * cursor as a consumed change-feed page.
 */
export const SessionAccessProbeV1Schema = z.object({
  v: z.literal(1),
  sessionId: ChangeSessionIdSchema,
  throughCursor: z.number().int().min(0),
  status: SessionAccessWitnessStatusV1Schema,
}).strict();

export type SessionAccessProbeV1 = z.infer<typeof SessionAccessProbeV1Schema>;

export const ChangesResponseSchema = z.object({
  changes: z.array(ChangeEntrySchema),
  nextCursor: z.number().int().min(0),
  sessionAccessWitness: SessionAccessWitnessV1Schema.optional(),
  sessionAccessProbe: SessionAccessProbeV1Schema.optional(),
}).strict().superRefine((response, context) => {
  if (
    response.sessionAccessWitness !== undefined
    && response.sessionAccessWitness.throughCursor !== response.nextCursor
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Session access witness must be captured through nextCursor.',
    });
  }
  if (response.sessionAccessProbe !== undefined) {
    if (
      response.sessionAccessProbe.throughCursor !== response.nextCursor
      || response.changes.length !== 0
      || response.sessionAccessWitness !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Session access probe must be the sole fact captured through nextCursor.',
      });
    }
  }
});

export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;

export const CurrentCursorResponseSchema = z.object({
  cursor: z.number().int().min(0),
  changesFloor: z.number().int().min(0),
}).strict();

export type CurrentCursorResponse = z.infer<typeof CurrentCursorResponseSchema>;

export const CursorGoneErrorSchema = z.object({
  error: z.literal('cursor-gone'),
  currentCursor: z.number().int().min(0),
}).strict();

export type CursorGoneError = z.infer<typeof CursorGoneErrorSchema>;
