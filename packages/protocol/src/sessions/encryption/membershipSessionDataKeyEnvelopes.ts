import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { TeamErrorCodeV1Schema } from '../../teams/errors.js';
import { SessionIndexedIdentifierMaxLengthV1 } from '../idsV1.js';
import {
  SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
  SessionDataKeyEnvelopeBytesV1Schema,
  SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
  SessionDataKeyRecipientContentKeyV1Schema,
} from './sessionDataKeyEnvelopes.js';

/**
 * Wire contract for Team/Group membership-history Session data-key preparation
 * (`GET`/`PATCH` under `.../members/.../sessions/data-key/envelopes`).
 *
 * The page is a bounded projection of work the caller may already read and
 * manage. It deliberately carries no Session title, no inaccessible Session
 * identity, no global total, and no envelope fingerprint/generation: those
 * facts decide nothing here and would disclose Sessions the caller cannot see.
 *
 * Envelope bytes, recipient Account identity, the content-key binding and the
 * page bound come from the per-Session collection owner. Team and Group history
 * are a different subject over the same envelopes, not a second key format.
 */

const MEMBERSHIP_SESSION_DATA_KEY_ENVELOPE_CURSOR_V1_PREFIX = 'msdke_cursor_v1_' as const;
const BASE64URL_ALPHABET_PATTERN = /^[A-Za-z0-9_-]+$/u;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Route-local keyset cursor over the stable Session identifier. Neither the V2
 * meaningful-activity cursor nor the per-Session recipient cursor is reused:
 * this page walks Sessions for one membership, and activity ordering can change
 * while preparation runs.
 */
export function encodeMembershipSessionDataKeyEnvelopeCursorV1(afterSessionId: string): string {
  const sessionId = MembershipHistorySessionIdV1Schema.parse(afterSessionId);
  return `${MEMBERSHIP_SESSION_DATA_KEY_ENVELOPE_CURSOR_V1_PREFIX}${encodeBase64(
    textEncoder.encode(sessionId),
    'base64url',
  )}`;
}

export function decodeMembershipSessionDataKeyEnvelopeCursorV1(cursor: string): string | null {
  if (typeof cursor !== 'string') return null;
  if (!cursor.startsWith(MEMBERSHIP_SESSION_DATA_KEY_ENVELOPE_CURSOR_V1_PREFIX)) return null;
  const payload = cursor.slice(MEMBERSHIP_SESSION_DATA_KEY_ENVELOPE_CURSOR_V1_PREFIX.length);
  if (!BASE64URL_ALPHABET_PATTERN.test(payload) || payload.length % 4 === 1) return null;
  let sessionId: string;
  try {
    const decoded = decodeBase64(payload, 'base64url');
    if (encodeBase64(decoded, 'base64url') !== payload) return null;
    sessionId = textDecoder.decode(decoded);
  } catch {
    return null;
  }
  return MembershipHistorySessionIdV1Schema.safeParse(sessionId).success ? sessionId : null;
}

const MembershipSessionDataKeyEnvelopeCursorSchema = z.string().check(z.refine((value) => decodeMembershipSessionDataKeyEnvelopeCursorV1(value) !== null, { message: 'Invalid membership session data-key cursor' }));

/** Session IDs key the page order and the cursor, like the other indexed Session identifiers. */
export const MembershipHistorySessionIdV1Schema = z.string().check(z.minLength(1), z.maxLength(SessionIndexedIdentifierMaxLengthV1), z.regex(/^(?!\s)[\s\S]*\S$(?![\s\S])/u));

/** Only the actionable page exists: this resource never lists non-work. */
export const MembershipSessionDataKeyEnvelopePageQueryV1Schema = z.strictObject({
  state: z._default(z.literal('action_required'), 'action_required'),
  limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1)), SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1),
  cursor: z.optional(MembershipSessionDataKeyEnvelopeCursorSchema),
});
export type MembershipSessionDataKeyEnvelopePageQueryV1 =
  Readonly<z.infer<typeof MembershipSessionDataKeyEnvelopePageQueryV1Schema>>;

/** Data-key failures reachable from the nested membership-history resource. */
export const MembershipSessionDataKeyEnvelopeErrorCodeV1Schema = z.enum([
  'invalid_request',
  'invalid_cursor',
  'forbidden',
  'recipient_changed',
  'recipient_key_unavailable',
  'session_data_key_unavailable',
]);
export type MembershipSessionDataKeyEnvelopeErrorCodeV1 =
  z.infer<typeof MembershipSessionDataKeyEnvelopeErrorCodeV1Schema>;

/**
 * One strict response body at the boundary where Team addressing and Session
 * envelope work meet. Each code still belongs to its original domain owner.
 */
export const MembershipSessionDataKeyEnvelopeErrorV1Schema = z.strictObject({
  error: z.union([TeamErrorCodeV1Schema, MembershipSessionDataKeyEnvelopeErrorCodeV1Schema]),
});
export type MembershipSessionDataKeyEnvelopeErrorV1 =
  Readonly<z.infer<typeof MembershipSessionDataKeyEnvelopeErrorV1Schema>>;

/**
 * The caller's own current envelope travels with each actionable Session so a
 * cold client never needs one Session-detail request per item.
 *
 * The Session's stored shared `metadata` ciphertext and `metadataLayoutVersion`
 * travel with it so the client can prove, with `readSessionKeyBoundSharedMetadataV1`,
 * that the key the Home names is this Session's before resealing it to someone
 * else. Both are optional only for mixed versions: an older Home omits them, and
 * a client then reseals nothing for that item.
 */
const MembershipSessionDataKeyEnvelopeItemV1Schema = z.strictObject({
  sessionId: MembershipHistorySessionIdV1Schema,
  callerDataKeyEnvelope: SessionDataKeyEnvelopeBytesV1Schema,
  metadata: z.optional(z.string()),
  metadataLayoutVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
});
export type MembershipSessionDataKeyEnvelopeItemV1 =
  Readonly<z.infer<typeof MembershipSessionDataKeyEnvelopeItemV1Schema>>;

function hasUniqueSessionIds(entries: ReadonlyArray<{ sessionId: string }>): boolean {
  return new Set(entries.map((entry) => entry.sessionId)).size === entries.length;
}

/**
 * Counts, not identities: they let the caller explain why some manageable
 * Sessions are not actionable without disclosing anything about Sessions the
 * caller cannot inspect. The two buckets do not overlap, and neither is work.
 */
export const MembershipSessionDataKeyEnvelopeExceptionsV1Schema = z.strictObject({
  callerVisibleNonTransferableSessionCount: z.number().check(z.int(), z.nonnegative()),
  callerEnvelopeRepairRequiredCount: z.number().check(z.int(), z.nonnegative()),
});
export type MembershipSessionDataKeyEnvelopeExceptionsV1 =
  Readonly<z.infer<typeof MembershipSessionDataKeyEnvelopeExceptionsV1Schema>>;

/**
 * The target binding is returned once per page rather than once per Session,
 * and only when the recipient can actually receive an envelope. An unavailable
 * recipient is a whole-page state: there is no per-Session work to show.
 */
export const MembershipSessionDataKeyEnvelopePageV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('recipient_unavailable'),
    recipientAccountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
    contentKey: lazyZodSchema(() => SessionDataKeyRecipientContentKeyV1Schema.check(z.refine((contentKey) => contentKey.status === 'unavailable', { message: 'An unavailable recipient page cannot carry a usable binding' }))),
  }),
  z.strictObject({
    status: z.literal('ready'),
    recipientAccountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
    contentKey: lazyZodSchema(() => SessionDataKeyRecipientContentKeyV1Schema.check(z.refine((contentKey) => contentKey.status === 'available', { message: 'A ready page requires the verified recipient binding' }))),
    items: z.array(MembershipSessionDataKeyEnvelopeItemV1Schema).check(z.maxLength(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1), z.refine(hasUniqueSessionIds, { message: 'Duplicate session ids' })),
    // Cursorless discovery and the cursorless final recheck carry the
    // authoritative aggregate. Continuations omit it so paging work never
    // reparses the entire authorized history merely to advance one page.
    exceptions: z.nullable(MembershipSessionDataKeyEnvelopeExceptionsV1Schema),
    nextCursor: z.nullable(MembershipSessionDataKeyEnvelopeCursorSchema),
  }),
]);
export type MembershipSessionDataKeyEnvelopePageV1 =
  Readonly<z.infer<typeof MembershipSessionDataKeyEnvelopePageV1Schema>>;

/**
 * `recipientAccountId` echoes the discovery target exactly once. Membership
 * identity is not enough: a provider reset can keep a Team membership id while
 * replacing its Account, and ciphertext sealed to the previous Account must
 * never land in the replacement Account's tuple.
 */
export const PatchMembershipSessionDataKeyEnvelopesV1Schema = z.strictObject({
  recipientAccountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
  entries: z.array(z.strictObject({
    sessionId: MembershipHistorySessionIdV1Schema,
    encryptedDataKey: SessionDataKeyEnvelopeBytesV1Schema,
  })).check(z.minLength(1), z.maxLength(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1), z.refine(hasUniqueSessionIds, { message: 'Duplicate session ids' })),
});
export type PatchMembershipSessionDataKeyEnvelopesV1 =
  Readonly<z.infer<typeof PatchMembershipSessionDataKeyEnvelopesV1Schema>>;

/** The next GET supplies current work; no per-entry receipt, digest or revision exists. */
export const PatchMembershipSessionDataKeyEnvelopesResultV1Schema = z.strictObject({
  appliedCount: z.number().check(z.int(), z.nonnegative()),
});
export type PatchMembershipSessionDataKeyEnvelopesResultV1 =
  Readonly<z.infer<typeof PatchMembershipSessionDataKeyEnvelopesResultV1Schema>>;
