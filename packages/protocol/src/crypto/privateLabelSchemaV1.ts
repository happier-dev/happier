import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import {
  SavedSecretResourceRecipientEnvelopeV1Schema,
  type SavedSecretResourceRecipientEnvelopeV1,
} from '../account/settings/savedSecretCatalogV1.js';
import { SessionDataKeyEnvelopeRecipientAccountIdV1Schema } from '../sessions/encryption/sessionDataKeyEnvelopes.js';
import { readCanonicalPaddedBase64DecodedLength } from './base64.js';
import { ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES, ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES } from './accountScopedCipherEnvelope.js';

export const PrivateLabelBindingV1Schema = lazyZodSchema(() => z.strictObject({
  entity: z.string().check(z.minLength(1), z.trim()),
  field: z.string().check(z.minLength(1), z.trim()),
  id: z.string().check(z.minLength(1), z.trim()),
}));
export type PrivateLabelBindingV1 = Readonly<z.infer<typeof PrivateLabelBindingV1Schema>>;

const PrivateLabelCiphertextV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => {
  const decodedLength = readCanonicalPaddedBase64DecodedLength(value);
  return decodedLength !== null && decodedLength >= ACCOUNT_SCOPED_SECRETBOX_NONCE_BYTES + ACCOUNT_SCOPED_SECRETBOX_OVERHEAD_BYTES;
}, 'Expected canonical private-label ciphertext')));

export const PrivateLabelContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: z.string() }),
  z.strictObject({ t: z.literal('encrypted'), c: PrivateLabelCiphertextV1Schema }),
]));
export type PrivateLabelContentV1 = Readonly<z.infer<typeof PrivateLabelContentV1Schema>>;

export function matchesPrivateLabelContentModeV1(
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
