import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import {
  isForbiddenQualifiedConnectedAccountCredentialKey,
  QualifiedConnectedAccountCredentialKeyV1Schema,
} from './qualifiedConnectedAccountCredentialKeyV1.js';
export { QualifiedConnectedAccountCredentialKeyV1Schema } from './qualifiedConnectedAccountCredentialKeyV1.js';

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
import { parseSavedSecretRefV1 } from '../account/settings/savedSecretReferenceV1.js';

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
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || isForbiddenQualifiedConnectedAccountCredentialKey(key)) return false;
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

const QualifiedConnectedAccountCredentialValuesV1Schema = lazyZodSchema(() => z.pipe(z
  .custom<Readonly<Record<string, string>>>(isStrictCredentialValues, {
    message: 'Qualified Connected Account credentials must be strict plain string data',
  }), z.record(
    QualifiedConnectedAccountCredentialKeyV1Schema,
    z.string().check(z.maxLength(500_000)),
  )).check(z.superRefine((values, context) => {
    const entries = Object.entries(values);
    if (entries.length > 64) {
      context.addIssue({
        code: "custom",
        message: 'Qualified Connected Account credentials exceed the 64-field limit',
      });
    }
    const totalCharacters = entries.reduce(
      (total, [key, value]) => total + key.length + value.length,
      0,
    );
    if (totalCharacters > 1_000_000) {
      context.addIssue({
        code: "custom",
        message: 'Qualified Connected Account credentials exceed the total size limit',
      });
    }
  })));

function isSharedSavedSecretResourceRef(value: string): boolean {
  try {
    return parseSavedSecretRefV1(value).kind === 'shared_resource';
  } catch {
    return false;
  }
}

/**
 * A declared secret credential field held by its one Saved Secret resource.
 * The credential stores only the reference; material resolves late through
 * the reader's Saved Secret catalog, so a rotation of that resource is what
 * every consumer reads next.
 */
const QualifiedConnectedAccountCredentialSecretRefsV1Schema = lazyZodSchema(() => z.pipe(z
  .custom<Readonly<Record<string, string>>>(isStrictCredentialValues, {
    message: 'Qualified Connected Account secret references must be strict plain string data',
  }), z.record(
    QualifiedConnectedAccountCredentialKeyV1Schema,
    z.string().check(z.refine(isSharedSavedSecretResourceRef, 'Expected a shared Saved Secret resource reference')),
  )).check(z.superRefine((refs, context) => {
    if (Object.keys(refs).length > 64) {
      context.addIssue({ code: 'custom', message: 'Qualified Connected Account secret references exceed the 64-field limit' });
    }
  })));

export const QualifiedConnectedAccountCredentialPayloadV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  values: QualifiedConnectedAccountCredentialValuesV1Schema,
  secretRefs: z.optional(QualifiedConnectedAccountCredentialSecretRefsV1Schema),
}).check(z.superRefine((payload, context) => {
  // One key has one custodian: inline bytes or a Saved Secret resource, never both.
  for (const key of Object.keys(payload.secretRefs ?? {})) {
    if (Object.hasOwn(payload.values, key)) {
      context.addIssue({ code: 'custom', path: ['secretRefs', key], message: 'A credential key cannot hold both inline bytes and a Saved Secret reference' });
    }
  }
})));

export type QualifiedConnectedAccountCredentialPayloadV1 = z.infer<
  typeof QualifiedConnectedAccountCredentialPayloadV1Schema
>;

export class QualifiedConnectedAccountCredentialSecretUnavailableError extends Error {
  readonly code = 'connected_account_credential_secret_unavailable' as const;
  constructor() {
    super('A Connected Account credential secret is unavailable');
    this.name = 'QualifiedConnectedAccountCredentialSecretUnavailableError';
  }
}

/**
 * The one late resolution of referenced credential secrets. Readers that hand
 * credential values to a consumer call this; writers keep the unresolved
 * payload so a re-seal never copies resource bytes back into the credential.
 */
export async function resolveQualifiedConnectedAccountCredentialValuesV1(
  payload: QualifiedConnectedAccountCredentialPayloadV1,
  readSecret: (reference: string) => Promise<string | null>,
): Promise<Readonly<{ v: 1; values: Readonly<Record<string, string>> }>> {
  const refs = Object.entries(payload.secretRefs ?? {});
  if (refs.length === 0) return { v: 1, values: payload.values };
  const values: Record<string, string> = { ...payload.values };
  for (const [key, reference] of refs) {
    const value = await readSecret(reference);
    if (typeof value !== 'string') throw new QualifiedConnectedAccountCredentialSecretUnavailableError();
    values[key] = value;
  }
  return { v: 1, values: QualifiedConnectedAccountCredentialPayloadV1Schema.parse({ v: 1, values }).values };
}

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
