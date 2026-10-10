import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { AccountRecipientEnvelopeUnavailableReasonSchema } from '../../account/encryptionMode.js';

import {
  ACCOUNT_CONTENT_KEY_BINDING_SIGNATURE_BYTES_V1,
  ACCOUNT_CONTENT_PUBLIC_KEY_BYTES_V1,
  ACCOUNT_SIGNING_PUBLIC_KEY_BYTES_V1,
} from '../../crypto/accountContentKeyBindingFormatV1.js';
import {
  decodeBase64,
  encodeBase64,
  readCanonicalPaddedBase64DecodedLength,
} from '../../crypto/base64.js';
import {
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_BASE64_LENGTH,
  ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
} from '../../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { SessionIndexedIdentifierMaxLengthV1 } from '../idsV1.js';

/**
 * Wire contract for the per-Session recipient data-key envelope collection
 * (`GET`/`PATCH /v2/sessions/:sessionId/data-key/envelopes`).
 *
 * This module owns only the strict boundary shapes and the summary-bucket
 * precedence rule shared by the server aggregate and the client presentation.
 * Effective access, the recipient audience, Account content-key readiness, and
 * the canonical `(Session, Account)` tuple read/write stay with their owners.
 *
 * This is a browser-reachable wire contract: it reaches the UI plugin client,
 * so it may consume only the pure format leaves that state envelope and
 * binding sizes, never a seal/open/sign implementation. Structural admission
 * needs the sizes, not the primitives that produce them.
 */

/** Exactly the fixed data-key envelope the canonical codec produces. */
export const SESSION_DATA_KEY_ENVELOPE_BYTES_V1 = ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES;

/** Canonical padded Base64 length of one envelope; no envelope is any other size. */
export const SESSION_DATA_KEY_ENVELOPE_BASE64_LENGTH_V1 = ENCRYPTED_DATA_KEY_ENVELOPE_V1_BASE64_LENGTH;

/**
 * One exception page and one atomic `PATCH` share this bound: the manager
 * client seals exactly the page it fetched and commits it in one transaction,
 * so a second constant would let a page become uncommittable.
 *
 * This bounds the HTTP and database resources one request consumes. It is not
 * a crypto responsiveness slice, and a page must not be read as one. Sealing
 * is sliced by the existing cooperative chunk owner, independently of how many
 * entries a page carries: measured against the real verify-plus-seal path on
 * local Linux arm64 / Node 24.20.0, 10 recipients at the default chunk of 32
 * cost 176.74 ms total with a 176.64 ms longest uninterrupted slice, 100 cost
 * 1195.90 ms / 440.84 ms, and 500 cost 8208.16 ms / 828.47 ms (the recipient
 * opened every envelope and checked key equality). A page-sized seal therefore
 * does not fit 50 ms, and shrinking the page would not make it fit — only the
 * chunk owner's tuning does: at chunk 1 the longest slice measured 43.73 ms,
 * 59.81 ms and 142.59 ms for those same sizes under shared load. That host is
 * not a browser or native certification, so it bounds neither.
 *
 * The approved large-fanout boundary is 500 recipients. The canonical SQLite
 * owner exercises 10, 100, and 500 entries as single atomic tuple-write plus
 * private AccountChange transactions, while the Protocol test proves the
 * worst-case 500-entry JSON body remains below the server's canonical 100 MiB
 * request boundary. This is a per-request bound, not a total audience limit:
 * larger audiences continue through the same keyset resource. The measurement
 * is evidence that the supported boundary is practical, not a wall-clock SLA.
 */
export const SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 = 500;

/** Recipient Account IDs key an indexed column and the keyset cursor. */
export const SESSION_DATA_KEY_ENVELOPE_RECIPIENT_ACCOUNT_ID_MAX_LENGTH_V1 =
  SessionIndexedIdentifierMaxLengthV1;

const SESSION_DATA_KEY_ENVELOPE_CURSOR_V1_PREFIX = 'sdke_cursor_v1_' as const;

// Same contract the canonical indexed identifiers use (`SessionIdSchema` in
// `../idsV1.ts`): no leading or trailing whitespace, and one non-whitespace
// character is a valid identifier.
const NO_OUTER_WHITESPACE_PATTERN = /^(?!\s)[\s\S]*\S$(?![\s\S])/u;
const BASE64URL_ALPHABET_PATTERN = /^[A-Za-z0-9_-]+$/u;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export const SessionDataKeyEnvelopeRecipientAccountIdV1Schema = lazyZodSchema(() => z.string()
  .min(1)
  .max(SESSION_DATA_KEY_ENVELOPE_RECIPIENT_ACCOUNT_ID_MAX_LENGTH_V1)
  .regex(NO_OUTER_WHITESPACE_PATTERN));

function canonicalBase64BytesSchema(exactBytes: number): z.ZodString {
  return z.string().refine((value) => {
    if (readCanonicalPaddedBase64DecodedLength(value) !== exactBytes) return false;
    return encodeBase64(decodeBase64(value, 'base64')) === value;
  }, { message: `Expected canonical Base64 of exactly ${exactBytes} bytes` });
}

/**
 * Structural admission only. The exact version/format parse and the Account
 * binding verification stay with the Session envelope service and the Protocol
 * codec; a well-formed request is not a usable envelope.
 */
export const SessionDataKeyEnvelopeBytesV1Schema = canonicalBase64BytesSchema(
  SESSION_DATA_KEY_ENVELOPE_BYTES_V1,
);

const AccountSigningPublicKeyHexV1Schema = lazyZodSchema(() => z.string().regex(
  new RegExp(`^[0-9a-fA-F]{${ACCOUNT_SIGNING_PUBLIC_KEY_BYTES_V1 * 2}}$`, 'u'),
));

export function encodeSessionDataKeyEnvelopeCursorV1(afterAccountId: string): string {
  const accountId = SessionDataKeyEnvelopeRecipientAccountIdV1Schema.parse(afterAccountId);
  return `${SESSION_DATA_KEY_ENVELOPE_CURSOR_V1_PREFIX}${
    encodeBase64(textEncoder.encode(accountId), 'base64url')
  }`;
}

export function decodeSessionDataKeyEnvelopeCursorV1(cursor: string): string | null {
  if (typeof cursor !== 'string') return null;
  if (!cursor.startsWith(SESSION_DATA_KEY_ENVELOPE_CURSOR_V1_PREFIX)) return null;
  const payload = cursor.slice(SESSION_DATA_KEY_ENVELOPE_CURSOR_V1_PREFIX.length);
  if (!BASE64URL_ALPHABET_PATTERN.test(payload)) return null;
  if (payload.length % 4 === 1) return null;
  let accountId: string;
  try {
    const decoded = decodeBase64(payload, 'base64url');
    if (encodeBase64(decoded, 'base64url') !== payload) return null;
    accountId = textDecoder.decode(decoded);
  } catch {
    return null;
  }
  return SessionDataKeyEnvelopeRecipientAccountIdV1Schema.safeParse(accountId).success
    ? accountId
    : null;
}

const SessionDataKeyEnvelopeCursorV1Schema = lazyZodSchema(() => z.string().refine(
  (value) => decodeSessionDataKeyEnvelopeCursorV1(value) !== null,
  { message: 'Invalid cursor' },
));

/**
 * `action_required` is the working page: exceptions only, so a healthy Team
 * never forces the manager to load every member. `all` is the same manager's
 * diagnostic view of the same Session-scoped audience.
 */
export const SessionDataKeyEnvelopePageStateV1Schema = lazyZodSchema(() => z.enum(['action_required', 'all']));
export type SessionDataKeyEnvelopePageStateV1 = z.infer<typeof SessionDataKeyEnvelopePageStateV1Schema>;

export const SessionDataKeyEnvelopePageQueryV1Schema = lazyZodSchema(() => z.object({
  state: SessionDataKeyEnvelopePageStateV1Schema.default('action_required'),
  limit: z.coerce.number().int().min(1).max(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1)
    .default(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1),
  cursor: SessionDataKeyEnvelopeCursorV1Schema.optional(),
}).strict());
export type SessionDataKeyEnvelopePageQueryV1 = Readonly<
  z.infer<typeof SessionDataKeyEnvelopePageQueryV1Schema>
>;

/**
 * Why a recipient cannot receive an envelope at all. The Account encryption
 * owner decides these; this resource only reports them.
 */
export const SessionDataKeyRecipientUnavailableReasonV1Schema = AccountRecipientEnvelopeUnavailableReasonSchema;
export type SessionDataKeyRecipientUnavailableReasonV1 = z.infer<
  typeof SessionDataKeyRecipientUnavailableReasonV1Schema
>;

export const SessionDataKeyRecipientContentKeyV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    accountSigningPublicKey: AccountSigningPublicKeyHexV1Schema,
    contentPublicKey: canonicalBase64BytesSchema(ACCOUNT_CONTENT_PUBLIC_KEY_BYTES_V1),
    contentPublicKeySignature: canonicalBase64BytesSchema(
      ACCOUNT_CONTENT_KEY_BINDING_SIGNATURE_BYTES_V1,
    ),
  }).strict(),
  z.object({
    status: z.literal('unavailable'),
    reason: SessionDataKeyRecipientUnavailableReasonV1Schema,
  }).strict(),
]));
export type SessionDataKeyRecipientContentKeyV1 = Readonly<
  z.infer<typeof SessionDataKeyRecipientContentKeyV1Schema>
>;

/** Describes stored bytes only, independently of recipient readiness. */
export const SessionDataKeyEnvelopeStateV1Schema = lazyZodSchema(() => z.enum(['prepared', 'missing', 'invalid']));
export type SessionDataKeyEnvelopeStateV1 = z.infer<typeof SessionDataKeyEnvelopeStateV1Schema>;

/**
 * Deliberately carries no grant source, Team/Group id, role, name, or avatar:
 * the Collaboration editor joins those display facts by Account ID through the
 * access owner's existing projection.
 */
export const SessionDataKeyEnvelopeItemV1Schema = lazyZodSchema(() => z.object({
  recipientAccountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
  envelopeState: SessionDataKeyEnvelopeStateV1Schema,
  contentKey: SessionDataKeyRecipientContentKeyV1Schema,
}).strict());
export type SessionDataKeyEnvelopeItemV1 = Readonly<z.infer<typeof SessionDataKeyEnvelopeItemV1Schema>>;

export const SessionDataKeyEnvelopeSummaryV1Schema = lazyZodSchema(() => z.object({
  prepared: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  recipientKeyUnavailable: z.number().int().nonnegative(),
}).strict());
export type SessionDataKeyEnvelopeSummaryV1 = Readonly<
  z.infer<typeof SessionDataKeyEnvelopeSummaryV1Schema>
>;

export const SessionDataKeyEnvelopePageV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_required') }).strict(),
  z.object({
    status: z.literal('required'),
    // Cursorless discovery/final recheck carries the authoritative aggregate;
    // a continuation is a bounded keyset page and deliberately carries none.
    summary: SessionDataKeyEnvelopeSummaryV1Schema.nullable(),
    items: z.array(SessionDataKeyEnvelopeItemV1Schema).max(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1),
    nextCursor: SessionDataKeyEnvelopeCursorV1Schema.nullable(),
  }).strict(),
]));
export type SessionDataKeyEnvelopePageV1 = Readonly<z.infer<typeof SessionDataKeyEnvelopePageV1Schema>>;

export type SessionDataKeyEnvelopeSummaryBucketV1 = keyof SessionDataKeyEnvelopeSummaryV1;

/**
 * The one owner of summary-bucket precedence. Unavailable recipient readiness
 * is exclusive: an inert tuple left behind by an earlier preparation cannot
 * report a Plain or inconsistent Account as prepared. Structural validity of
 * stored bytes is never a claim that the recipient can open them.
 */
export function classifySessionDataKeyEnvelopeItemV1(
  item: Pick<SessionDataKeyEnvelopeItemV1, 'envelopeState' | 'contentKey'>,
): SessionDataKeyEnvelopeSummaryBucketV1 {
  if (item.contentKey.status === 'unavailable') return 'recipientKeyUnavailable';
  switch (item.envelopeState) {
    case 'prepared': return 'prepared';
    case 'missing': return 'pending';
    case 'invalid': return 'invalid';
  }
}

export const PatchSessionDataKeyEnvelopeEntryV1Schema = lazyZodSchema(() => z.object({
  recipientAccountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
  encryptedDataKey: SessionDataKeyEnvelopeBytesV1Schema,
}).strict());
export type PatchSessionDataKeyEnvelopeEntryV1 = Readonly<
  z.infer<typeof PatchSessionDataKeyEnvelopeEntryV1Schema>
>;

export const PatchSessionDataKeyEnvelopesV1Schema = lazyZodSchema(() => z.object({
  entries: z.array(PatchSessionDataKeyEnvelopeEntryV1Schema)
    .min(1)
    .max(SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1)
    .refine(
      (entries) => new Set(entries.map((entry) => entry.recipientAccountId)).size === entries.length,
      { message: 'Duplicate recipientAccountId' },
    ),
}).strict());
export type PatchSessionDataKeyEnvelopesV1 = Readonly<{
  entries: readonly PatchSessionDataKeyEnvelopeEntryV1[];
}>;

/** The whole bounded request commits or rejects; there is no per-entry receipt. */
export const PatchSessionDataKeyEnvelopesResultV1Schema = lazyZodSchema(() => z.object({
  appliedCount: z.number().int().nonnegative(),
}).strict());
export type PatchSessionDataKeyEnvelopesResultV1 = Readonly<
  z.infer<typeof PatchSessionDataKeyEnvelopesResultV1Schema>
>;

/**
 * The single optional envelope a direct access-grant operation may carry.
 *
 * It is a versioned object rather than a bare Base64 string so the grant
 * operation can tell "this caller sent nothing" apart from "this caller sent
 * something this server cannot interpret", and so a Plain Session can answer
 * `invalid_request` for supplied recipient material instead of ignoring it.
 * Structural admission only: the sealed envelope still has to open against the
 * recipient's current binding, which stays with the Session envelope service.
 */
export const SessionRecipientEnvelopeInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  encryptedDataKey: SessionDataKeyEnvelopeBytesV1Schema,
}).strict());
export type SessionRecipientEnvelopeInputV1 = Readonly<
  z.infer<typeof SessionRecipientEnvelopeInputV1Schema>
>;

/** Stable codes decide the response; there are no per-item errors or retry flags. */
export const SessionDataKeyEnvelopeErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'invalid_cursor',
  'session_not_found',
  'forbidden',
  'session_access_authentication_required',
  'session_access_authentication_unavailable',
  'data_key_not_required',
  'recipient_envelope_required',
  'recipient_changed',
  'recipient_key_unavailable',
  'session_data_key_unavailable',
]));
export type SessionDataKeyEnvelopeErrorCodeV1 = z.infer<typeof SessionDataKeyEnvelopeErrorCodeV1Schema>;
