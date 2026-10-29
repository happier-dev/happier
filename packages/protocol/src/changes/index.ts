import { lazyZodSchema } from '../lazyZodSchema.js';
export { buildChangesReadRequest, CHANGES_AFTER_CURSOR_HTTP_HEADER } from './readRequest.js';
import { z } from 'zod/mini';

import { SessionIdSchema } from '../sessions/idsV1.js';
import { formatSharedSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';
import { PluginDomainChangeEntrySchema } from './pluginDomain.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import { ProviderAccountUsageRecordIdSchema } from '../connect/providerAccountUsagePrimitives.js';
import { ConnectedAccountServiceIdentityV1Schema } from '../connect/qualifiedConnectedAccountPersistence.js';
import type { QualifiedConnectedAccountServiceRef } from '../connect/qualifiedConnectedAccountsV4.js';
import { buildQualifiedPluginContributionKey } from '../plugins/contributionKey.js';

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

/** Recipient/access-specific Machine projection invalidation on the existing AccountChange feed. */
export const MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1 = 'machineRecipientAccess' as const;

export const ChangeKindSchema = lazyZodSchema(() => z.enum([
  'account',
  'automation',
  'artifact',
  'discussion',
  'feed',
  'friends',
  'friend_request',
  'friend_accepted',
  'kv',
  'machine',
  MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1,
  'machinePool',
  'pet',
  'pluginDomain',
  'savedSecretResource',
  'session',
  'share',
]));

export type ChangeKind = z.infer<typeof ChangeKindSchema>;

export function isMachineProjectionChangeKindV1(kind: string): kind is 'machine' | typeof MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1 {
  return kind === 'machine' || kind === MACHINE_RECIPIENT_ACCESS_CHANGE_KIND_V1;
}

/** AccountChange entity identities for reconstructible Home administration projections. */
export const HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'home-governance' as const;
export const TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'teams' as const;
/** Delivered/withdrawn credential material changes no Team or source authority.
 * A separate coalescing row preserves any pending Team-authority invalidation. */
export const TEAM_CREDENTIAL_MATERIAL_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'team-credential-material' as const;
/** Separate coalescing rows keep service invalidations relative to the reader's cursor. */
const CONNECTED_SERVICE_ACCOUNT_CHANGE_PREFIX_V1 = 'connected-service:';
const CONNECTED_SERVICES_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'connected-services';
export const ConnectedServicesAccountChangeV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('account'),
    entityId: z.literal(CONNECTED_SERVICES_ACCOUNT_CHANGE_ENTITY_ID_V1),
    hint: z.strictObject({ connectedServices: z.literal(true) }),
  }),
  z.strictObject({
    kind: z.literal('account'),
    entityId: z.string(),
    hint: z.strictObject({
      connectedServices: z.literal(true),
      connectedServiceRef: asProtocolZod(ConnectedAccountServiceIdentityV1Schema),
    }),
  }).check(z.refine(change => change.entityId === `${CONNECTED_SERVICE_ACCOUNT_CHANGE_PREFIX_V1}${buildQualifiedPluginContributionKey(change.hint.connectedServiceRef)}`)),
]));

export function buildConnectedServicesAccountChangeV1(service?: QualifiedConnectedAccountServiceRef) {
  return ConnectedServicesAccountChangeV1Schema.parse(service
    ? { kind: 'account', entityId: `${CONNECTED_SERVICE_ACCOUNT_CHANGE_PREFIX_V1}${buildQualifiedPluginContributionKey(service)}`,
      hint: { connectedServices: true, connectedServiceRef: service } }
    : { kind: 'account', entityId: CONNECTED_SERVICES_ACCOUNT_CHANGE_ENTITY_ID_V1, hint: { connectedServices: true } });
}

export type ConnectedServicesAccountChangeScopeV1 =
  | Readonly<{ scope: 'service'; ref: QualifiedConnectedAccountServiceRef }>
  | Readonly<{ scope: 'all' }>;

/** Also reads content-free wake identities; a supplied durable hint must agree with its entity. */
export function readConnectedServicesAccountChangeV1(
  change: Readonly<{ kind: string; entityId: string; hint?: unknown }>,
): ConnectedServicesAccountChangeScopeV1 | null {
  if (change.kind !== 'account') return null;
  // Retained rows and 0.2 servers publish the coarse self flag. Never narrow it from extra fields.
  if (change.entityId === 'self') {
    const hint = change.hint;
    return hint !== null && typeof hint === 'object' && !Array.isArray(hint)
      && 'connectedServices' in hint && hint.connectedServices === true ? { scope: 'all' } : null;
  }
  if (change.entityId !== CONNECTED_SERVICES_ACCOUNT_CHANGE_ENTITY_ID_V1
    && !change.entityId.startsWith(CONNECTED_SERVICE_ACCOUNT_CHANGE_PREFIX_V1)) return null;
  if (change.hint === undefined) {
    if (change.entityId === CONNECTED_SERVICES_ACCOUNT_CHANGE_ENTITY_ID_V1) return { scope: 'all' };
    const key = change.entityId.slice(CONNECTED_SERVICE_ACCOUNT_CHANGE_PREFIX_V1.length);
    const separator = key.indexOf('/');
    const ref = ConnectedAccountServiceIdentityV1Schema.safeParse({ pluginId: key.slice(0, separator), localId: key.slice(separator + 1) });
    return separator > 0 && ref.success ? { scope: 'service', ref: ref.data } : null;
  }
  const parsed = ConnectedServicesAccountChangeV1Schema.safeParse({ kind: change.kind, entityId: change.entityId, hint: change.hint });
  if (!parsed.success) return null;
  return 'connectedServiceRef' in parsed.data.hint
    ? { scope: 'service', ref: parsed.data.hint.connectedServiceRef } : { scope: 'all' };
}

/** Content-free invalidation for accepted material Provider Account allowance observations. */
export const PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'provider-account-usage' as const;
/** Advisory refresh routing on the existing Account feed; never credential authority. */
export const ProviderAccountUsageRefreshChangeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('account'),
  entityId: z.string(),
  hint: z.strictObject({ providerAccountUsageRefresh: z.literal(true), recordId: ProviderAccountUsageRecordIdSchema }),
}).check(z.refine(change => change.entityId === `provider-account-usage-refresh:${change.hint.recordId}`)));

export function buildProviderAccountUsageRefreshChangeV1(recordId: string) {
  return ProviderAccountUsageRefreshChangeV1Schema.parse({ kind: 'account',
    entityId: `provider-account-usage-refresh:${recordId}`, hint: { providerAccountUsageRefresh: true, recordId } });
}

export function readProviderAccountUsageRefreshRecordIdV1(change: Readonly<{ kind: string; entityId: string; hint?: unknown }>): string | null {
  if (change.kind !== 'account' || !change.entityId.startsWith('provider-account-usage-refresh:')) return null;
  const parsed = ProviderAccountUsageRefreshChangeV1Schema.safeParse({ kind: change.kind, entityId: change.entityId, hint: change.hint });
  return parsed.success ? parsed.data.hint.recordId : null;
}
/**
 * Coalescing identity for the creator's Runner-activation projection.
 *
 * Endpoint-driven activation transitions (claim, endpoint facts, consent,
 * readiness, decline) are the only activation facts a creator cannot learn from
 * its own request result. Waking on this entity lets the mounted creator refetch
 * the canonical activation projection instead of running a timer.
 */
export const EPHEMERAL_RUNNER_ACTIVATION_ACCOUNT_CHANGE_ENTITY_ID_V1 = 'ephemeral-runner-activation' as const;

/** Additive-open advisory hint for the canonical Session Organization owner. */
export const SessionOrganizationChangeHintSchema = lazyZodSchema(() => z.looseObject({
  sessionOrganization: z.literal(true),
  scope: z.enum(['pins', 'folders', 'folderAssignments', 'tags', 'tagAssignments', 'order', 'labels', 'attentionStandings', 'sessionAppearances']),
  sessionIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  folderIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  tagIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  deletedTagIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  scopeKeys: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
  orderScopes: z.optional(z.array(z.object({
    scopeKind: z.enum(['pinned', 'folder', 'tag', 'workspace', 'group']),
    scopeKey: z.string().check(z.trim(), z.minLength(1)),
  }))),
}));

export type SessionOrganizationChangeHint = z.infer<typeof SessionOrganizationChangeHintSchema>;

export const ChangeEntrySchema = lazyZodSchema(() => z.strictObject({
  cursor: z.number().check(z.int(), z.minimum(0)),
  kind: z.string().check(z.trim(), z.minLength(1)),
  entityId: z.string(),
  changedAt: z.number().check(z.int(), z.minimum(0)),
  hint: z.optional(z.nullable(z.unknown())),
}).check(z.superRefine((entry, context) => {
  if (entry.kind === 'pluginDomain' && !PluginDomainChangeEntrySchema.safeParse(entry).success) {
    context.addIssue({
      code: "custom",
      message: 'Invalid pluginDomain AccountChange entry.',
    });
  }
  if (entry.kind === 'savedSecretResource') {
    try {
      formatSharedSavedSecretRefV1(entry.entityId);
    } catch {
      context.addIssue({
        code: "custom",
        message: 'Invalid savedSecretResource AccountChange entityId.',
      });
    }
    if (entry.hint !== null && entry.hint !== undefined) {
      context.addIssue({
        code: "custom",
        message: 'savedSecretResource AccountChange does not carry a hint.',
      });
    }
  }
})));

export type ChangeEntry = z.infer<typeof ChangeEntrySchema>;

/** The existing Account cursor preceding a run of projection-only Session writes. */
export function readSessionFollowProjectionOnlySinceCursorV1(hint: unknown): number | null {
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return null;
  const record = hint as Record<string, unknown>;
  const cursor = record.followSourceUnchangedSinceCursor;
  return record.followSourceChanged === false && typeof cursor === 'number'
    && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
}

/** A coalesced title/read projection cannot hide a source fact not yet consumed. */
export function readSessionFollowSourceChangedV1(
  change: Readonly<{ kind: string; cursor: number; hint?: unknown }>, afterCursor: number,
): boolean {
  const since = change.kind === 'session' ? readSessionFollowProjectionOnlySinceCursorV1(change.hint) : null;
  return since === null || !Number.isSafeInteger(afterCursor) || afterCursor < since || since >= change.cursor;
}

/** Availability is advisory; a retained event is relevant only before its Account cursor. */
export function readSessionFollowReceiverAvailabilityChangedV1(
  change: Readonly<{ kind: string; cursor: number; hint?: unknown }>, afterCursor: number,
): boolean | undefined {
  if (change.kind !== 'session') return false;
  if (!change.hint || typeof change.hint !== 'object' || Array.isArray(change.hint)) return undefined;
  const hint = change.hint as Record<string, unknown>;
  if (hint.followReceiverAvailabilityChanged === false) return false;
  if (hint.followReceiverAvailabilityChanged === undefined) return undefined;
  if (hint.followReceiverAvailabilityChanged !== true) return false;
  const eventCursor = hint.followReceiverAvailabilityChangedAtCursor;
  const at = typeof eventCursor === 'number' && Number.isSafeInteger(eventCursor)
    && eventCursor > 0 && eventCursor <= change.cursor ? eventCursor : change.cursor;
  return !Number.isSafeInteger(afterCursor) || afterCursor < at;
}

/** Append and revision hints share the existing Session transcript carrier. */
export function readSessionTranscriptChangeHintV1(
  change: Readonly<{ kind: string; hint?: unknown }>,
): Readonly<{ seq: number; messageId?: string }> | null {
  if (change.kind !== 'session' && change.kind !== 'share') return null;
  const hint = change.hint;
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return null;
  const record = hint as Record<string, unknown>;
  const appended = typeof record.lastMessageSeq === 'number';
  const seq = appended ? record.lastMessageSeq : record.updatedMessageSeq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null;
  const id = appended ? record.lastMessageId : record.updatedMessageId;
  const messageId = typeof id === 'string' ? id.trim() : '';
  return messageId ? { seq, messageId } : { seq };
}

/** The server's existing advisory hint for a durable row revised at unchanged seq. */
export function readSessionUpdatedMessageChangeHintV1(
  change: Readonly<{ kind: string; hint?: unknown }>,
): Readonly<{ seq: number; messageId: string }> | null {
  if (change.kind !== 'session' && change.kind !== 'share') return null;
  const hint = change.hint;
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return null;
  const record = hint as Record<string, unknown>;
  const seq = record.updatedMessageSeq;
  const messageId = typeof record.updatedMessageId === 'string' ? record.updatedMessageId.trim() : '';
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0 || !messageId) return null;
  return { seq: Math.trunc(seq), messageId };
}

/**
 * Durable Account-change fact emitted only after the Server has committed the
 * physical Session deletion. Ordinary Account-relative unavailability (for
 * example share revocation) deliberately carries no such hint.
 */
export const SessionDeletedChangeHintV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  lifecycle: z.literal('deleted'),
}));

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

export const SessionAccessWitnessStatusV1Schema = lazyZodSchema(() => z.enum([
  'available',
  'unavailable',
]));

export type SessionAccessWitnessStatusV1 = z.infer<
  typeof SessionAccessWitnessStatusV1Schema
>;

export const SessionAccessWitnessEntryV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  cursor: z.number().check(z.int(), z.minimum(0)),
  status: SessionAccessWitnessStatusV1Schema,
}));

export type SessionAccessWitnessEntryV1 = z.infer<
  typeof SessionAccessWitnessEntryV1Schema
>;

/**
 * Account-change pages carry this additive proof when the server can attest
 * the current Account-scoped access state of every Session change on the
 * page. It is intentionally optional for supported older servers; callers
 * decide which scoped operation must fail closed when it is absent.
 */
export const SessionAccessWitnessV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  throughCursor: z.number().check(z.int(), z.minimum(0)),
  entries: z.array(SessionAccessWitnessEntryV1Schema).check(z.maxLength(500)),
}).check(z.superRefine((witness, context) => {
  const sessionIds = new Set<string>();
  for (const entry of witness.entries) {
    if (entry.cursor > witness.throughCursor) {
      context.addIssue({
        code: "custom",
        message: 'Session access witness entry exceeds its captured cursor.',
      });
    }
    if (sessionIds.has(entry.sessionId)) {
      context.addIssue({
        code: "custom",
        message: 'Session access witness has duplicate Session entries.',
      });
    }
    sessionIds.add(entry.sessionId);
  }
})));

export type SessionAccessWitnessV1 = z.infer<typeof SessionAccessWitnessV1Schema>;

/**
 * Host-private, one-Session access proof returned by the incumbent Account
 * change carrier. Callers use it for admission only and never acknowledge its
 * cursor as a consumed change-feed page.
 */
export const SessionAccessProbeV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: ChangeSessionIdSchema,
  throughCursor: z.number().check(z.int(), z.minimum(0)),
  status: SessionAccessWitnessStatusV1Schema,
}));

export type SessionAccessProbeV1 = z.infer<typeof SessionAccessProbeV1Schema>;

export const ChangesResponseSchema = lazyZodSchema(() => z.strictObject({
  changes: z.array(ChangeEntrySchema),
  nextCursor: z.number().check(z.int(), z.minimum(0)),
  sessionAccessWitness: z.optional(SessionAccessWitnessV1Schema),
  sessionAccessProbe: z.optional(SessionAccessProbeV1Schema),
}).check(z.superRefine((response, context) => {
  if (
    response.sessionAccessWitness !== undefined
    && response.sessionAccessWitness.throughCursor !== response.nextCursor
  ) {
    context.addIssue({
      code: "custom",
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
        code: "custom",
        message: 'Session access probe must be the sole fact captured through nextCursor.',
      });
    }
  }
})));

export type ChangesResponse = z.infer<typeof ChangesResponseSchema>;

export const CurrentCursorResponseSchema = lazyZodSchema(() => z.strictObject({
  cursor: z.number().check(z.int(), z.minimum(0)),
  changesFloor: z.number().check(z.int(), z.minimum(0)),
}));

export type CurrentCursorResponse = z.infer<typeof CurrentCursorResponseSchema>;

export const CursorGoneErrorSchema = lazyZodSchema(() => z.strictObject({
  error: z.literal('cursor-gone'),
  currentCursor: z.number().check(z.int(), z.minimum(0)),
}));

export type CursorGoneError = z.infer<typeof CursorGoneErrorSchema>;
