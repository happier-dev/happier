import tweetnacl from 'tweetnacl';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import {
  SavedSecretResourceRecipientEnvelopeV1Schema,
  type SavedSecretResourceRecipientEnvelopeV1,
} from '../account/settings/savedSecretCatalogV1.js';
import { SessionDataKeyEnvelopeRecipientAccountIdV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { decodeBase64, encodeBase64, readCanonicalPaddedBase64DecodedLength } from './base64.js';
import { deriveKey } from './keyDerivation.js';

const PRIVATE_LABEL_KEY_USAGE_V1 = 'Happier private label v1';

export const PrivateLabelBindingV1Schema = lazyZodSchema(() => z.strictObject({
  entity: z.string().check(z.minLength(1), z.trim()),
  field: z.string().check(z.minLength(1), z.trim()),
  id: z.string().check(z.minLength(1), z.trim()),
}));
export type PrivateLabelBindingV1 = Readonly<z.infer<typeof PrivateLabelBindingV1Schema>>;

const PrivateLabelCiphertextV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => {
  const decodedLength = readCanonicalPaddedBase64DecodedLength(value);
  return decodedLength !== null && decodedLength >= tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength;
}, 'Expected canonical private-label ciphertext')));

export const PrivateLabelContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: z.string() }),
  z.strictObject({ t: z.literal('encrypted'), c: PrivateLabelCiphertextV1Schema }),
]));
export type PrivateLabelContentV1 = Readonly<z.infer<typeof PrivateLabelContentV1Schema>>;

function matchesPrivateLabelContentModeV1(
  mode: 'plain' | 'e2ee',
  content: PrivateLabelContentV1,
): boolean {
  return (mode === 'plain') === (content.t === 'plain');
}

/** The Saved Secret owner defines the standard data-key envelope representation. */
export { SavedSecretResourceRecipientEnvelopeV1Schema as PrivateLabelRecipientEnvelopeV1Schema };
export type { SavedSecretResourceRecipientEnvelopeV1 as PrivateLabelRecipientEnvelopeV1 };

export const PrivateLabelRecipientV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: SessionDataKeyEnvelopeRecipientAccountIdV1Schema,
  envelope: SavedSecretResourceRecipientEnvelopeV1Schema,
}));
export type PrivateLabelRecipientV1 = Readonly<z.infer<typeof PrivateLabelRecipientV1Schema>>;

/** Opaque JSON persisted in an existing String column. */
export const PrivateLabelStoredV1Schema = lazyZodSchema(() => z.strictObject({
  content: PrivateLabelContentV1Schema,
  recipients: z.array(PrivateLabelRecipientV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.content.t === 'plain' && value.recipients.length !== 0) {
    context.addIssue({ code: 'custom', message: 'Plain private labels cannot carry recipient envelopes' });
  }
  if (value.content.t === 'encrypted' && value.recipients.length === 0) {
    context.addIssue({ code: 'custom', message: 'Encrypted private labels require recipient envelopes' });
  }
  const accountIds = new Set<string>();
  for (const recipient of value.recipients) {
    if (accountIds.has(recipient.accountId)) {
      context.addIssue({ code: 'custom', message: 'Private-label recipients must be unique by Account' });
      break;
    }
    accountIds.add(recipient.accountId);
  }
})));
export type PrivateLabelStoredV1 = Readonly<z.infer<typeof PrivateLabelStoredV1Schema>>;

/** The persisted owner mode, never the viewing Account mode, decides content admissibility. */
export type PrivateLabelStoredModeValidationV1 =
  | Readonly<{ kind: 'available'; stored: PrivateLabelStoredV1 }>
  | Readonly<{ kind: 'invalid_stored_content' }>
  | Readonly<{ kind: 'mode_mismatch' }>;

export function validatePrivateLabelStoredForModeV1(params: Readonly<{
  mode: 'plain' | 'e2ee';
  stored: unknown;
}>): PrivateLabelStoredModeValidationV1 {
  const stored = PrivateLabelStoredV1Schema.safeParse(params.stored);
  if (!stored.success) return { kind: 'invalid_stored_content' };
  if (!matchesPrivateLabelContentModeV1(params.mode, stored.data.content)) return { kind: 'mode_mismatch' };
  return { kind: 'available', stored: stored.data };
}

/** Reader projection: the server returns at most the envelope for the requesting Account. */
export const PrivateLabelReadV1Schema = lazyZodSchema(() => z.strictObject({
  content: PrivateLabelContentV1Schema,
  recipientEnvelope: z.nullable(SavedSecretResourceRecipientEnvelopeV1Schema),
  // Read-only provenance for raw pre-envelope rows; never accepted by stored writes.
  legacyPlaintext: z.optional(z.literal(true)),
}).check(z.superRefine((value, context) => {
  if (value.legacyPlaintext === true && value.content.t !== 'plain') {
    context.addIssue({ code: 'custom', message: 'Legacy plaintext provenance requires plain content' });
  }
  if (value.content.t === 'plain' && value.recipientEnvelope !== null) {
    context.addIssue({ code: 'custom', message: 'Plain private labels cannot carry a reader envelope' });
  }
})));
export type PrivateLabelReadV1 = Readonly<z.infer<typeof PrivateLabelReadV1Schema>>;

/**
 * The caller's established owner policy for interpreting a recipient projection.
 * Account-owned labels must agree with their captured persisted Account mode;
 * Team resources retain their strict stored arm because a viewer's mode is not
 * the Team author's mode.
 */
export type PrivateLabelReadPolicyV1 =
  | Readonly<{ kind: 'account-owned'; contentEncryptionMode: 'plain' | 'e2ee' }>
  | Readonly<{ kind: 'team-resource' }>;

const PrivateLabelEncryptedPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  binding: PrivateLabelBindingV1Schema,
  value: z.string(),
}));

type SealPrivateLabelV1Params =
  | Readonly<{
      mode: 'plain';
      binding: PrivateLabelBindingV1;
      value: string;
    }>
  | Readonly<{
      mode: 'e2ee';
      binding: PrivateLabelBindingV1;
      value: string;
      dataKey: Uint8Array;
      recipients: readonly PrivateLabelRecipientV1[];
      randomBytes: (length: number) => Uint8Array;
    }>;

function sameBinding(left: PrivateLabelBindingV1, right: PrivateLabelBindingV1): boolean {
  return left.entity === right.entity && left.field === right.field && left.id === right.id;
}

function isDataKey(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === tweetnacl.secretbox.keyLength;
}

function derivePrivateLabelContentKeyV1(dataKey: Uint8Array, binding: PrivateLabelBindingV1): Uint8Array {
  return deriveKey(dataKey, PRIVATE_LABEL_KEY_USAGE_V1, [binding.entity, binding.field, binding.id]);
}

/**
 * Creates a keyless plain label or a ciphertext bound to one entity/field/id.
 * Recipient data-key envelopes are prepared by the Saved Secret recipient owner.
 */
export function sealPrivateLabelV1(params: SealPrivateLabelV1Params): PrivateLabelStoredV1 {
  const binding = PrivateLabelBindingV1Schema.parse(params.binding);
  if (params.mode === 'plain') {
    return PrivateLabelStoredV1Schema.parse({
      content: { t: 'plain', v: params.value },
      recipients: [],
    });
  }
  if (!isDataKey(params.dataKey)) throw new TypeError('Private-label data key must be 32 bytes');
  const recipients = params.recipients.map((recipient) => PrivateLabelRecipientV1Schema.parse(recipient));
  if (recipients.length === 0) throw new TypeError('Encrypted private labels require recipient envelopes');
  if (new Set(recipients.map((recipient) => recipient.accountId)).size !== recipients.length) {
    throw new TypeError('Private-label recipients must be unique by Account');
  }
  const nonce = params.randomBytes(tweetnacl.secretbox.nonceLength);
  if (nonce.byteLength !== tweetnacl.secretbox.nonceLength) throw new TypeError('Invalid private-label encryption nonce');
  const payload = PrivateLabelEncryptedPayloadV1Schema.parse({ v: 1, binding, value: params.value });
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const boxed = tweetnacl.secretbox(plaintext, nonce, derivePrivateLabelContentKeyV1(params.dataKey, binding));
  const ciphertext = new Uint8Array(nonce.byteLength + boxed.byteLength);
  ciphertext.set(nonce);
  ciphertext.set(boxed, nonce.byteLength);
  return PrivateLabelStoredV1Schema.parse({
    content: { t: 'encrypted', c: encodeBase64(ciphertext, 'base64') },
    recipients,
  });
}

function readPrivateLabelContentV1(label: unknown): Readonly<{ content: PrivateLabelContentV1; legacyPlaintext?: true }> | null {
  const stored = PrivateLabelStoredV1Schema.safeParse(label);
  if (stored.success) return { content: stored.data.content };
  const read = PrivateLabelReadV1Schema.safeParse(label);
  return read.success ? read.data : null;
}

function admitsPrivateLabelContentV1(
  readPolicy: PrivateLabelReadPolicyV1 | null | undefined,
  content: PrivateLabelContentV1,
): boolean {
  if (readPolicy?.kind === 'team-resource') return true;
  return readPolicy?.kind === 'account-owned'
    && matchesPrivateLabelContentModeV1(readPolicy.contentEncryptionMode, content);
}

/** Opens only content whose authenticated binding is exactly the requested entity/field/id. */
export function openPrivateLabelV1(params: Readonly<{
  binding: PrivateLabelBindingV1;
  label: unknown;
  /** Required owner policy; never infer it from the binding or viewing Account. */
  readPolicy: PrivateLabelReadPolicyV1;
  dataKey?: Uint8Array;
}>): string | null {
  try {
    const binding = PrivateLabelBindingV1Schema.safeParse(params.binding);
    const label = readPrivateLabelContentV1(params.label);
    if (!binding.success || !label) return null;
    const { content } = label;
    if (label.legacyPlaintext !== true && !admitsPrivateLabelContentV1(params.readPolicy, content)) return null;
    if (content.t === 'plain') return content.v;
    if (!isDataKey(params.dataKey)) return null;
    const combined = decodeBase64(content.c, 'base64');
    if (combined.byteLength < tweetnacl.secretbox.nonceLength + tweetnacl.secretbox.overheadLength) return null;
    const opened = tweetnacl.secretbox.open(
      combined.subarray(tweetnacl.secretbox.nonceLength),
      combined.subarray(0, tweetnacl.secretbox.nonceLength),
      derivePrivateLabelContentKeyV1(params.dataKey, binding.data),
    );
    if (!opened) return null;
    const payload = PrivateLabelEncryptedPayloadV1Schema.safeParse(JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(opened),
    ));
    return payload.success && sameBinding(payload.data.binding, binding.data) ? payload.data.value : null;
  } catch {
    return null;
  }
}

/** Removes the recipient audience from a server response without reinterpreting content. */
export function projectPrivateLabelForRecipientV1(params: Readonly<{
  stored: PrivateLabelStoredV1;
  recipientAccountId: string;
  legacyPlaintext?: true;
}>): PrivateLabelReadV1 {
  const stored = PrivateLabelStoredV1Schema.parse(params.stored);
  const recipientAccountId = SessionDataKeyEnvelopeRecipientAccountIdV1Schema.parse(params.recipientAccountId);
  return PrivateLabelReadV1Schema.parse({
    content: stored.content,
    ...(params.legacyPlaintext === true ? { legacyPlaintext: true } : {}),
    recipientEnvelope: stored.content.t === 'encrypted'
      ? stored.recipients.find((recipient) => recipient.accountId === recipientAccountId)?.envelope ?? null
      : null,
  });
}

export type PrivateLabelStoredParseV1 =
  | Readonly<{ kind: 'current'; stored: PrivateLabelStoredV1 }>
  | Readonly<{ kind: 'legacy_plain'; stored: PrivateLabelStoredV1 }>
  | Readonly<{ kind: 'invalid' }>;

function isPrivateLabelEnvelopeCandidateV1(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && ('content' in value || 'recipients' in value
      || ('t' in value && (value.t === 'plain' || value.t === 'encrypted')));
}

/**
 * Legacy raw String rows are accepted only when their storage owner
 * explicitly opts in. A JSON object that claims this envelope shape but fails
 * validation is never reinterpreted as plaintext.
 */
export function parsePrivateLabelStoredV1(
  serialized: string,
  options: Readonly<{ allowLegacyPlaintext?: boolean }> = {},
): PrivateLabelStoredParseV1 {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (isPrivateLabelEnvelopeCandidateV1(parsed)) {
      const stored = PrivateLabelStoredV1Schema.safeParse(parsed);
      return stored.success ? { kind: 'current', stored: stored.data } : { kind: 'invalid' };
    }
  } catch {
    // Truncated envelope JSON still claims an envelope, never a legacy label.
    if (/^\s*\{[\s\S]*"(?:content|recipients)"\s*:/.test(serialized)
      || /^\s*\{[\s\S]*"t"\s*:\s*"(?:plain|encrypted)"/.test(serialized)) return { kind: 'invalid' };
  }
  return options.allowLegacyPlaintext
    ? { kind: 'legacy_plain', stored: { content: { t: 'plain', v: serialized }, recipients: [] } }
    : { kind: 'invalid' };
}

export function serializePrivateLabelStoredV1(stored: PrivateLabelStoredV1): string {
  return JSON.stringify(PrivateLabelStoredV1Schema.parse(stored));
}
