import tweetnacl from 'tweetnacl';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { decodeBase64, encodeBase64 } from './base64.js';
import { deriveKey } from './keyDerivation.js';
import {
  PrivateLabelBindingV1Schema,
  PrivateLabelReadV1Schema,
  PrivateLabelRecipientV1Schema,
  PrivateLabelStoredV1Schema,
  matchesPrivateLabelContentModeV1,
  type PrivateLabelBindingV1,
  type PrivateLabelContentV1,
  type PrivateLabelRecipientV1,
  type PrivateLabelStoredV1,
} from './privateLabelSchemaV1.js';
export {
  PrivateLabelBindingV1Schema,
  PrivateLabelContentV1Schema,
  PrivateLabelReadV1Schema,
  PrivateLabelRecipientEnvelopeV1Schema,
  PrivateLabelRecipientV1Schema,
  PrivateLabelStoredV1Schema,
  parsePrivateLabelStoredV1,
  projectPrivateLabelForRecipientV1,
  serializePrivateLabelStoredV1,
  validatePrivateLabelStoredForModeV1,
  type PrivateLabelBindingV1,
  type PrivateLabelContentV1,
  type PrivateLabelReadV1,
  type PrivateLabelRecipientEnvelopeV1,
  type PrivateLabelRecipientV1,
  type PrivateLabelStoredModeValidationV1,
  type PrivateLabelStoredParseV1,
  type PrivateLabelStoredV1,
} from './privateLabelSchemaV1.js';

const PRIVATE_LABEL_KEY_USAGE_V1 = 'Happier private label v1';

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
