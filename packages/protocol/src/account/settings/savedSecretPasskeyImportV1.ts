import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SavedSecretPasskeySourceV1Schema, type SavedSecretPasskeySourceV1 } from './savedSecretPasskeySourceV1.js';

export type SavedSecretPasskeyImportResultV1 =
  | Readonly<{ status: 'ready'; source: SavedSecretPasskeySourceV1 }>
  | Readonly<{ status: 'source_format_unsupported' | 'input_invalid' }>;

// Chrome DevTools Protocol WebAuthn.Credential: privateKey is ECDSA P-256 PKCS#8.
// https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/#type-Credential
const ChromiumCredentialSchema = lazyZodSchema(() => {
  const fields = SavedSecretPasskeySourceV1Schema.shape;
  return z.strictObject({
    credentialId: fields.credentialId,
    isResidentCredential: z.boolean(),
    rpId: fields.rpId,
    privateKey: fields.privateKey,
    userHandle: fields.userHandle,
    signCount: z.number().check(z.int(), z.minimum(-1), z.maximum(0xffffffff)),
    backupEligibility: z.optional(fields.backupEligibility),
    backupState: z.optional(fields.backupState),
    userName: fields.userName,
    userDisplayName: fields.userDisplayName,
    largeBlob: z.optional(z.unknown()),
    cmtgKeys: z.optional(z.unknown()),
    activeCmtgKeyIndex: z.optional(z.unknown()),
    generateCmtgKeyOnNextOperation: z.optional(z.unknown()),
  });
});

/** Structural ingestion only; the native destination validates PKCS#8 key support. */
export function parseSavedSecretPasskeyImportV1(input: Readonly<{ format: unknown; value: unknown }>): SavedSecretPasskeyImportResultV1 {
  // CXF omits backup metadata; never invent it from the destination's defaults.
  if (input.format !== 'chromium-cdp') return { status: 'source_format_unsupported' };
  const parsed = ChromiumCredentialSchema.safeParse(input.value);
  if (!parsed.success) return { status: 'input_invalid' };
  const { isResidentCredential, largeBlob, cmtgKeys, activeCmtgKeyIndex,
    generateCmtgKeyOnNextOperation, ...credential } = parsed.data;
  if (!isResidentCredential || typeof credential.backupEligibility !== 'boolean'
    || typeof credential.backupState !== 'boolean' || largeBlob !== undefined
    || cmtgKeys !== undefined || activeCmtgKeyIndex !== undefined
    || generateCmtgKeyOnNextOperation !== undefined) return { status: 'source_format_unsupported' };
  const source = SavedSecretPasskeySourceV1Schema.safeParse({
    ...credential, kind: 'passkey', algorithm: -7,
    // CDP -1 disables the counter and reports zero for every assertion.
    signCount: credential.signCount === -1 ? 0 : credential.signCount,
  });
  return source.success ? { status: 'ready', source: source.data } : { status: 'input_invalid' };
}
