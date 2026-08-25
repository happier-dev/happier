import { z } from 'zod';

import {
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  type AccountScopedBlobKind,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import {
  StoredJsonContentEnvelopeSchema,
  type StoredJsonContentEnvelope,
} from '../storage/storedJsonContentEnvelope.js';
import {
  openConnectedServiceCredentialCiphertext,
  sealConnectedServiceCredentialCiphertext,
} from './connectedServiceCipher.js';

export type QualifiedConnectedAccountContentKind =
  | 'attempt'
  | 'credential'
  | 'configuration';

function isStrictCredentialValues(
  value: unknown,
): value is Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || forbidden.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !('value' in descriptor)
      || typeof descriptor.value !== 'string'
    ) {
      return false;
    }
  }
  return true;
}

const QualifiedConnectedAccountCredentialValuesV1Schema = z
  .custom<Readonly<Record<string, string>>>(isStrictCredentialValues, {
    message: 'Qualified Connected Account credentials must be strict plain string data',
  })
  .pipe(z.record(
    z.string().min(1).max(128),
    z.string().max(500_000),
  ))
  .superRefine((values, context) => {
    const entries = Object.entries(values);
    if (entries.length > 64) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Qualified Connected Account credentials exceed the 64-field limit',
      });
    }
    const totalCharacters = entries.reduce(
      (total, [key, value]) => total + key.length + value.length,
      0,
    );
    if (totalCharacters > 1_000_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Qualified Connected Account credentials exceed the total size limit',
      });
    }
  });

export const QualifiedConnectedAccountCredentialPayloadV1Schema = z.object({
  v: z.literal(1),
  values: QualifiedConnectedAccountCredentialValuesV1Schema,
}).strict();

export type QualifiedConnectedAccountCredentialPayloadV1 = z.infer<
  typeof QualifiedConnectedAccountCredentialPayloadV1Schema
>;

/**
 * Each non-credential Connected Account content kind owns its own ciphertext domain
 * byte, so an attempt transaction can never be opened as a configuration.
 */
function accountScopedBlobKindFor(
  kind: Exclude<QualifiedConnectedAccountContentKind, 'credential'>,
): AccountScopedBlobKind {
  return kind === 'attempt'
    ? 'qualified_connected_account_attempt_transaction'
    : 'qualified_connected_account_configuration';
}

type SealParams =
  | Readonly<{
      kind: QualifiedConnectedAccountContentKind;
      accountMode: 'plain';
      payload: unknown;
      randomBytes: (length: number) => Uint8Array;
    }>
  | Readonly<{
      kind: QualifiedConnectedAccountContentKind;
      accountMode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      payload: unknown;
      randomBytes: (length: number) => Uint8Array;
    }>;

type OpenParams =
  | Readonly<{
      kind: QualifiedConnectedAccountContentKind;
      accountMode: 'plain';
      envelope: StoredJsonContentEnvelope;
    }>
  | Readonly<{
      kind: QualifiedConnectedAccountContentKind;
      accountMode: 'e2ee';
      material: AccountScopedCryptoMaterial;
      envelope: StoredJsonContentEnvelope;
    }>;

export function sealQualifiedConnectedAccountContentEnvelope(
  params: SealParams,
): StoredJsonContentEnvelope {
  if (params.accountMode === 'plain') {
    return StoredJsonContentEnvelopeSchema.parse({
      t: 'plain',
      v: params.payload,
    });
  }
  const ciphertext = params.kind === 'credential'
    ? sealConnectedServiceCredentialCiphertext({
        material: params.material,
        payload: params.payload,
        randomBytes: params.randomBytes,
      })
    : sealAccountScopedBlobCiphertext({
        kind: accountScopedBlobKindFor(params.kind),
        material: params.material,
        payload: params.payload,
        randomBytes: params.randomBytes,
      });
  return StoredJsonContentEnvelopeSchema.parse({
    t: 'encrypted',
    c: ciphertext,
  });
}

export function openQualifiedConnectedAccountContentEnvelope(
  params: OpenParams,
): unknown | null {
  const envelope = StoredJsonContentEnvelopeSchema.parse(params.envelope);
  if (params.accountMode === 'plain') {
    return envelope.t === 'plain' ? envelope.v : null;
  }
  if (envelope.t !== 'encrypted') return null;
  const opened = params.kind === 'credential'
    ? openConnectedServiceCredentialCiphertext({
        material: params.material,
        ciphertext: envelope.c,
      })
    : openAccountScopedBlobCiphertext({
        kind: accountScopedBlobKindFor(params.kind),
        material: params.material,
        ciphertext: envelope.c,
      });
  return opened?.value ?? null;
}
