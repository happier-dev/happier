import { z } from 'zod';

import { SessionMessageRoleSchema, type SessionMessageRole } from './sessionMessageRole.js';
import { type SessionMessageProvenanceV1 } from './sessionInputAdmission.js';

const textEncoder = new TextEncoder();

export const MESSAGE_ACTION_VISIBLE_TEXT_MAX_UTF8_BYTES = 32 * 1024;
export const MESSAGE_ACTION_STRUCTURED_PRESENTATION_SUMMARY_MAX_UTF8_BYTES = 8 * 1024;

function strictNonBlankString(maxCharacters: number, label: string) {
  return z.string()
    .min(1)
    .max(maxCharacters)
    .refine((value) => value === value.trim(), `${label} must not have leading or trailing whitespace`);
}

function boundedDisclosureText(maxUtf8Bytes: number, label: string) {
  return z.string().refine(
    (value) => textEncoder.encode(value).byteLength <= maxUtf8Bytes,
    `${label} must contain at most ${maxUtf8Bytes} UTF-8 bytes`,
  );
}

export const MessageActionReferenceV1Schema = z.object({
  v: z.literal(1),
  sessionId: strictNonBlankString(512, 'sessionId'),
  messageId: strictNonBlankString(512, 'messageId'),
  observedRevision: strictNonBlankString(512, 'observedRevision'),
}).strict();

export type MessageActionReferenceV1 = z.infer<typeof MessageActionReferenceV1Schema>;

export const MessageActionContentCategoryV1Schema = z.enum([
  'text',
  'structured',
]);
export type MessageActionContentCategoryV1 = z.infer<typeof MessageActionContentCategoryV1Schema>;

/**
 * This is intentionally only a least-disclosure category. It is not a plugin,
 * Account, connection, provider, or source-reference identity.
 */
export const MessageActionProvenanceCategoryV1Schema = z.enum([
  'owner',
  'collaborator',
  'plugin',
  'external_human',
  'automation',
  'voice',
  'terminal',
  'recovered_history',
  'unknown',
]);
export type MessageActionProvenanceCategoryV1 = z.infer<typeof MessageActionProvenanceCategoryV1Schema>;

/**
 * Reduces the canonical provenance union to the only source fact a whole
 * Message Action may receive. This deliberately returns `unknown` for
 * provenance shapes without an approved least-disclosure category rather than
 * exposing an identifier, source reference, or implementation detail.
 */
export function projectMessageActionProvenanceCategoryV1(
  provenance: SessionMessageProvenanceV1 | null | undefined,
): MessageActionProvenanceCategoryV1 {
  if (!provenance) return 'unknown';

  switch (provenance.kind) {
    case 'happierApp':
      return provenance.actor.kind === 'owner' ? 'owner' : 'collaborator';
    case 'cli':
      return 'owner';
    case 'voice':
      return 'voice';
    case 'pluginSession':
      return provenance.externalActor?.kind === 'human' ? 'external_human' : 'plugin';
    case 'automation':
      return 'automation';
    case 'agentTerminal':
      return 'terminal';
    case 'host':
      switch (provenance.producer) {
        case 'happierApp':
        case 'cli':
        case 'daemonInitialPrompt':
          return 'owner';
        case 'pluginSession':
          return 'plugin';
        case 'automation':
          return 'automation';
        case 'voiceInput':
        case 'executionRunVoice':
          return 'voice';
        case 'agentTerminal':
          return 'terminal';
        case 'externalSessionHistory':
        case 'runtimeTranscript':
          return 'recovered_history';
        case 'sessionAction':
        case 'happierMcp':
        case 'connectedService':
        case 'agentRuntimeFirstInput':
          return 'unknown';
      }
    case 'happierSession':
      return 'unknown';
  }
}

export const MessageActionAvailableSnapshotV1Schema = z.object({
  sessionId: strictNonBlankString(512, 'sessionId'),
  messageId: strictNonBlankString(512, 'messageId'),
  observedRevision: strictNonBlankString(512, 'observedRevision'),
  role: SessionMessageRoleSchema,
  contentCategory: MessageActionContentCategoryV1Schema,
  seq: z.number().int().min(0),
  visibleText: boundedDisclosureText(
    MESSAGE_ACTION_VISIBLE_TEXT_MAX_UTF8_BYTES,
    'visibleText',
  ).nullable(),
  structuredPresentationSummary: boundedDisclosureText(
    MESSAGE_ACTION_STRUCTURED_PRESENTATION_SUMMARY_MAX_UTF8_BYTES,
    'structuredPresentationSummary',
  ).nullable(),
  provenanceCategory: MessageActionProvenanceCategoryV1Schema,
}).strict();

export type MessageActionAvailableSnapshotV1 = z.infer<typeof MessageActionAvailableSnapshotV1Schema>;

export const MessageActionResolutionV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    snapshot: MessageActionAvailableSnapshotV1Schema,
  }).strict(),
  z.object({ status: z.literal('stale') }).strict(),
  z.object({ status: z.literal('deleted') }).strict(),
  z.object({ status: z.literal('compacted') }).strict(),
  z.object({ status: z.literal('ineligible') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);

export type MessageActionResolutionV1 = z.infer<typeof MessageActionResolutionV1Schema>;

/**
 * The canonical Session/Message owner returns these durable facts before the
 * host builds the bounded handler disclosure snapshot. This remains separate
 * from `MessageActionResolutionV1`: the server never receives or returns
 * decrypted text, structured presentation data, or current SDK policy facts.
 */
export const MessageActionDurableResolutionV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    message: z.object({
      sessionId: strictNonBlankString(512, 'sessionId'),
      messageId: strictNonBlankString(512, 'messageId'),
      observedRevision: strictNonBlankString(512, 'observedRevision'),
      seq: z.number().int().min(0),
      messageRole: SessionMessageRoleSchema.nullable(),
    }).strict(),
  }).strict(),
  z.object({ status: z.literal('stale') }).strict(),
  z.object({ status: z.literal('deleted') }).strict(),
  z.object({ status: z.literal('compacted') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);
export type MessageActionDurableResolutionV1 = z.infer<typeof MessageActionDurableResolutionV1Schema>;

export type MessageActionCurrentStateV1 = 'available' | 'deleted' | 'compacted';

/**
 * Narrow facts supplied by the existing Message/access/publication/read owners.
 * This contract deliberately has no raw content, encrypted envelope, plugin
 * metadata, or Action execution policy; those remain owned by their existing
 * boundaries.
 */
export type CurrentMessageActionReferenceV1 = Readonly<{
  sessionId: string;
  messageId: string;
  observedRevision: string;
  state: MessageActionCurrentStateV1;
  accessible: boolean;
  mountCurrent: boolean;
  actionEligible: boolean;
  snapshot?: Readonly<{
    role: SessionMessageRole;
    contentCategory: MessageActionContentCategoryV1;
    seq: number;
    visibleText: string | null;
    structuredPresentationSummary: string | null;
    provenanceCategory: MessageActionProvenanceCategoryV1;
  }>;
}>;

function unavailable(status: Exclude<MessageActionResolutionV1['status'], 'available'>): MessageActionResolutionV1 {
  return { status };
}

/**
 * The sole ordering for mounted whole-message Action currentness. Access is
 * evaluated before row state so a caller without current Session access never
 * receives a deletion or compaction existence oracle. Action safety, current
 * intent, validation, and execution are intentionally not decided here.
 */
export function resolveMessageActionReferenceV1(params: Readonly<{
  reference: MessageActionReferenceV1;
  current: CurrentMessageActionReferenceV1;
}>): MessageActionResolutionV1 {
  const reference = MessageActionReferenceV1Schema.safeParse(params.reference);
  if (!reference.success) return unavailable('unavailable');

  const current = params.current;
  if (!current.accessible) return unavailable('unavailable');
  if (
    current.sessionId !== reference.data.sessionId
    || current.messageId !== reference.data.messageId
  ) {
    return unavailable('unavailable');
  }
  if (current.state === 'deleted') return unavailable('deleted');
  if (current.state === 'compacted') return unavailable('compacted');
  if (!current.mountCurrent || current.observedRevision !== reference.data.observedRevision) {
    return unavailable('stale');
  }
  if (!current.actionEligible || !current.snapshot) return unavailable('ineligible');

  const snapshot = MessageActionAvailableSnapshotV1Schema.safeParse({
    sessionId: current.sessionId,
    messageId: current.messageId,
    observedRevision: current.observedRevision,
    ...current.snapshot,
  });
  if (!snapshot.success) return unavailable('ineligible');
  return { status: 'available', snapshot: snapshot.data };
}

/**
 * Issuance uses the exact same currentness path as dispatch. The caller can
 * retain only this durable opaque identity; the bounded snapshot is resolved
 * afresh at every use.
 */
export function issueMessageActionReferenceV1(
  current: CurrentMessageActionReferenceV1,
): MessageActionReferenceV1 | null {
  const reference = MessageActionReferenceV1Schema.safeParse({
    v: 1,
    sessionId: current.sessionId,
    messageId: current.messageId,
    observedRevision: current.observedRevision,
  });
  if (!reference.success) return null;
  return resolveMessageActionReferenceV1({ reference: reference.data, current }).status === 'available'
    ? reference.data
    : null;
}
