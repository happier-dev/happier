import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import tweetnacl from 'tweetnacl';

import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret, type AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import {
  computeRunnerMachineContentKeyFingerprintV1,
  openRunnerMachineContentKeyVerifierFactV1,
  readRunnerMachineContentKeyBindingSignedPayloadV1,
  RunnerMachineContentKeyBindingV1Schema,
  verifyRunnerMachineContentKeyBindingV1,
} from '../ephemeralRunner/machineContentKeyBinding.js';
import { RunnerClaimV1Schema, verifyRunnerClaimV1 } from '../ephemeralRunner/endpoint.js';
import { MachineKindFromLegacyProjectionSchema } from './machineKind.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { MachineFinitePolicyV1StoredSchema } from './machineFinitePolicyV1.js';
import { AccessibleMachineAccessStoredReadV1Schema } from './machineAccessV1.js';

/** Known policy fields inside opened Machine metadata, not another content carrier. */
export const MachineStoredMetadataPolicyFieldsV1Schema = lazyZodSchema(() => z.object({
  finitePolicyV1: MachineFinitePolicyV1StoredSchema.optional(),
}));

const MachinePlainStoredContentEnvelopeSchema = lazyZodSchema(() => z.object({
  t: z.literal('plain'),
  v: z.json(),
}).strict());
const MachinePlainStoredContentReadSchema = createStoredReadSchema(MachinePlainStoredContentEnvelopeSchema);

function encodeMachinePlainEnvelope(value: unknown): string {
  let envelope: ReturnType<typeof MachinePlainStoredContentEnvelopeSchema.safeParse>;
  try {
    envelope = MachinePlainStoredContentEnvelopeSchema.safeParse(
      JSON.parse(JSON.stringify({ t: 'plain', v: value })),
    );
  } catch {
    throw new Error('Invalid plaintext machine content');
  }
  if (!envelope.success) {
    throw new Error('Invalid plaintext machine content');
  }
  return encodeBase64(
    new TextEncoder().encode(JSON.stringify(envelope.data)),
    'base64',
  );
}

function parseMachinePlainEnvelopeBytes(value: Uint8Array, strict = false): z.infer<
  typeof MachinePlainStoredContentEnvelopeSchema
> | null {
  try {
    const parsed = (strict ? MachinePlainStoredContentEnvelopeSchema : MachinePlainStoredContentReadSchema).safeParse(
      JSON.parse(new TextDecoder().decode(value)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseEncodedMachinePlainEnvelope(value: string, strict = false): z.infer<
  typeof MachinePlainStoredContentEnvelopeSchema
> | null {
  try {
    return parseMachinePlainEnvelopeBytes(decodeBase64(value, 'base64'), strict);
  } catch {
    return null;
  }
}

export const MACHINE_PLAIN_DATA_KEY_MARKER = encodeMachinePlainEnvelope(null);

export function isPlainMachineDataKeyMarker(
  value: string | Uint8Array | null | undefined,
): boolean {
  const envelope = typeof value === 'string'
    ? parseEncodedMachinePlainEnvelope(value)
    : value instanceof Uint8Array
      ? parseMachinePlainEnvelopeBytes(value)
      : null;
  return envelope?.v === null;
}

/** C40 provenance decision only; permission and raw publication safety remain separate owners. */
export function isMachineDataEncryptionKeyTransferableV1(params: Readonly<{
  publishedDataEncryptionKey: string | null | undefined;
  openedDataEncryptionKey: Uint8Array | null;
  accountScopedMaterial: AccountScopedCryptoMaterial;
}>): boolean {
  const key = params.openedDataEncryptionKey;
  if (!params.publishedDataEncryptionKey || isPlainMachineDataKeyMarker(params.publishedDataEncryptionKey)
    || !key || key.byteLength !== ENCRYPTED_DATA_KEY_V1_BYTES) return false;
  const material = params.accountScopedMaterial;
  const historicalKeys = material.type === 'dataKey' ? [material.machineKey]
    : [material.secret, deriveAccountMachineKeyFromRecoverySecret(material.secret)];
  return !historicalKeys.some(historical => historical.length === key.length
    && historical.every((byte, index) => byte === key[index]));
}

/** The C40 resource-key producer, shared by its CLI and UI lifecycle adapters. */
export function createMachineDataEncryptionKeyV1(params: Readonly<{
  material: AccountScopedCryptoMaterial;
  dataKeyPublicKey?: Uint8Array;
  randomBytes: (length: number) => Uint8Array;
}>): Readonly<{ encryptionKey: Uint8Array; encryptionVariant: 'dataKey'; dataEncryptionKey: Uint8Array }> {
  const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
    material: params.material, ...(params.dataKeyPublicKey ? { dataKeyPublicKey: params.dataKeyPublicKey } : {}) });
  const accountSecret = snapshot.material.type === 'dataKey' ? snapshot.material.machineKey
    : deriveAccountMachineKeyFromRecoverySecret(snapshot.material.secret);
  const encryptionKey = params.randomBytes(ENCRYPTED_DATA_KEY_V1_BYTES);
  const dataEncryptionKey = sealEncryptedDataKeyEnvelopeV1({ dataKey: encryptionKey,
    recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(accountSecret).publicKey, randomBytes: params.randomBytes });
  return { encryptionKey, encryptionVariant: 'dataKey', dataEncryptionKey };
}

export function encodePlainMachineStoredContent(value: unknown): string {
  return encodeMachinePlainEnvelope(value);
}

function isPlainMachineStoredContent(value: unknown, strict = false): boolean {
  return typeof value === 'string' && parseEncodedMachinePlainEnvelope(value, strict) !== null;
}

export function decodePlainMachineStoredContent(value: string): unknown {
  const envelope = parseEncodedMachinePlainEnvelope(value);
  if (!envelope) {
    throw new Error('Invalid plaintext machine content');
  }
  return envelope.v;
}

export function machineStoredContentMatchesAccountMode(params: Readonly<{
  mode: 'plain' | 'e2ee';
  metadata: string;
  daemonState?: string;
  dataEncryptionKey?: string | Uint8Array | null;
  /** Persistence inspection tolerates additive fields; mutation admission remains strict. */
  storedRead?: boolean;
}>): boolean {
  const hasPlainMarker = isPlainMachineDataKeyMarker(params.dataEncryptionKey);
  if (params.mode === 'plain') {
    return (
      hasPlainMarker
      && isPlainMachineStoredContent(params.metadata, params.storedRead !== true)
      && (
        params.daemonState === undefined
        || isPlainMachineStoredContent(params.daemonState, params.storedRead !== true)
      )
    );
  }
  return (
    !hasPlainMarker
    && !isPlainMachineStoredContent(params.metadata)
    && (
      params.daemonState === undefined
      || !isPlainMachineStoredContent(params.daemonState)
    )
  );
}

export function machineUpdateMatchesStoredMode(params: Readonly<{
  dataEncryptionKey?: string | Uint8Array | null;
  metadata?: string;
  daemonState?: string;
}>): boolean {
  const plain = isPlainMachineDataKeyMarker(params.dataEncryptionKey);
  if (plain) {
    return (
      (params.metadata === undefined || isPlainMachineStoredContent(params.metadata, true))
      && (params.daemonState === undefined || isPlainMachineStoredContent(params.daemonState, true))
    );
  }
  return (
    (params.metadata === undefined || !isPlainMachineStoredContent(params.metadata))
    && (params.daemonState === undefined || !isPlainMachineStoredContent(params.daemonState))
  );
}

export type PublishedMachineDataEncryptionKeyV1 = Readonly<{
  id: string;
  kind?: 'persistent' | 'ephemeral_session_runner';
  installationId?: string | null;
  dataEncryptionKey?: unknown;
  /** Authenticated resource facts, never the viewer Account's storage mode. */
  access?: unknown;
  runnerContentKeyBinding?: unknown;
  /**
   * Runner only; the activation-signed `RunnerClaimV1` persisted when the
   * endpoint claimed this Machine. Consulted only when the caller selected the
   * Runner by Session (`ExpectedRunnerMachineContentKeyBindingV1.sessionId`).
   */
  runnerClaim?: unknown;
}>;

export type PublishedMachineDataEncryptionKeyResolutionV1 =
  | Readonly<{ status: 'plain' }>
  | Readonly<{ status: 'legacy' }>
  | Readonly<{ status: 'e2ee'; dataKey: Uint8Array }>
  | Readonly<{ status: 'unavailable' }>;

export type ExpectedRunnerMachineContentKeyBindingV1 = Readonly<{
  /** Independently trusted Home identity; never accepted from the Home-published binding. */
  homeServerIdentityId: string;
  /** Independently trusted Account identity; never accepted from the Home-published binding. */
  creatorAccountId: string;
  /** Exact Machine selected by the caller; never accepted from the Home-published binding. */
  machineId: string;
  /**
   * Creator-device custody verifier. Present only on the creating device; a
   * Home-published Machine field is never accepted here.
   */
  accountSigningPublicKeyBase64Url?: string;
  /**
   * Account E2EE material of the reading device. Any authorized device of the
   * creator Account uses it to open the creator-sealed verifier fact carried by
   * the binding, which is how a non-creating device or daemon reaches the same
   * verifier identity. The Home holds no such material and cannot forge one.
   */
  accountScopedMaterial?: AccountScopedCryptoMaterial;
  /**
   * Exact Session the caller targets when it selected this Machine by Session.
   * The Machine-key binding does not sign a Session, so an authentic Runner key
   * is not by itself proof that this Runner holds that Session; when present,
   * the key is accepted only if the Runner's activation-signed claim — verified
   * under the same trusted activation identity that authenticates the binding —
   * names this exact Session, Machine and activation.
   */
  sessionId?: string;
}>;

/**
 * Proves a Home-selected Runner is the one activated for `expected.sessionId`.
 *
 * The claim is signed by the activation identity the caller already trusts
 * independently of the Home (creator custody or the Account-sealed verifier
 * fact), carries no credential, and binds activation, Session, Machine and the
 * winning installation together. Everything it names must equal the verified
 * Machine-key binding and the caller's own scope; the Home only relays it.
 */
function runnerClaimCorrespondsV1(params: Readonly<{
  claim: unknown;
  sessionId: string;
  activationId: string;
  installationId: string;
  activationSigningPublicKey: string;
  expected: ExpectedRunnerMachineContentKeyBindingV1;
}>): boolean {
  const parsed = RunnerClaimV1Schema.safeParse(params.claim);
  if (!parsed.success) return false;
  const claimed = parsed.data.payload.binding;
  if (
    claimed.sessionId !== params.sessionId
    || claimed.activationId !== params.activationId
    || claimed.machineId !== params.expected.machineId
    || claimed.homeServerIdentityId !== params.expected.homeServerIdentityId
    || claimed.creatorAccountId !== params.expected.creatorAccountId
    || claimed.activationSigningPublicKey !== params.activationSigningPublicKey
    || parsed.data.payload.installation.installationId !== params.installationId
  ) return false;
  return verifyRunnerClaimV1({ claim: parsed.data, expectedBinding: claimed }) !== null;
}

/**
 * The single post-envelope-open decision for published Machine content keys.
 *
 * Persistent Machines retain the released absent-envelope Account-key fallback.
 * A Runner never does: its opened key is usable only when a creator signing
 * identity the reader trusts independently of the Home authenticates the strict
 * binding. That identity is the creating device's own custody record, or — for
 * any other authorized device of the same Account — the creator-sealed verifier
 * fact opened with Account material the Home never holds. Home, creator, and
 * exact Machine come from caller scope; activation and installation are
 * accepted only as signed values, with installation also matching the row.
 *
 * Which branch a row takes is therefore never decided by the Home's own `kind`
 * alone: a caller that already knows this exact Machine is a Runner says so,
 * and the creator binding the Home only ever receives at Runner materialization
 * classifies the row by itself. Either fact makes the persistent fallback
 * unreachable, so relabelling a Runner `persistent` — or omitting the kind —
 * fails closed instead of disclosing a Home-chosen key.
 */
export function resolvePublishedMachineDataEncryptionKeyV1(params: Readonly<{
  machine: PublishedMachineDataEncryptionKeyV1;
  openedDataEncryptionKey: Uint8Array | null;
  expectedRunnerBinding?: ExpectedRunnerMachineContentKeyBindingV1;
  /** Trusted Account mode. A Home-published plain marker cannot decide it. */
  expectedAccountMode?: 'plain' | 'e2ee';
  /** Authenticated reading Account; only the custodian may read absent-envelope history. */
  viewerAccountId?: string;
  /**
   * Classification the caller established independently of this response —
   * creator-device custody, or the pins its own credential carries. Only the
   * Runner direction is assertable: nothing trusts "this is persistent".
   */
  trustedMachineKind?: 'ephemeral_session_runner';
}>): PublishedMachineDataEncryptionKeyResolutionV1 {
  const machineKind = MachineKindFromLegacyProjectionSchema.safeParse(params.machine.kind);
  if (!machineKind.success) return { status: 'unavailable' };

  const carriesRunnerContentKeyBinding = params.machine.runnerContentKeyBinding !== null
    && params.machine.runnerContentKeyBinding !== undefined;
  const isRunner = params.trustedMachineKind === 'ephemeral_session_runner'
    || carriesRunnerContentKeyBinding
    || machineKind.data === 'ephemeral_session_runner';

  const published = params.machine.dataEncryptionKey;
  const openedDataEncryptionKey = params.openedDataEncryptionKey;
  let expectedMode = params.expectedAccountMode;
  let mayReadLegacy = true;
  if (params.machine.access !== undefined) {
    const access = AccessibleMachineAccessStoredReadV1Schema.safeParse(params.machine.access);
    if (!access.success || access.data.accessState !== 'ready') return { status: 'unavailable' };
    expectedMode = access.data.resourceMode;
    mayReadLegacy = access.data.custodian.accountId === params.viewerAccountId;
  }
  if (!isRunner && expectedMode === 'plain') {
    return published === null || published === undefined || isPlainMachineDataKeyMarker(typeof published === 'string' ? published : null)
      ? { status: 'plain' }
      : { status: 'unavailable' };
  }
  if (typeof published === 'string' && isPlainMachineDataKeyMarker(published)) {
    if (
      expectedMode === 'e2ee'
      || (
        isRunner
        && (
          expectedMode !== 'plain'
          || carriesRunnerContentKeyBinding
        )
      )
    ) return { status: 'unavailable' };
    return { status: 'plain' };
  }

  if (!isRunner) {
    if (published === null || published === undefined) return { status: mayReadLegacy ? 'legacy' : 'unavailable' };
    return typeof published === 'string' && openedDataEncryptionKey !== null && openedDataEncryptionKey.length > 0
      ? { status: 'e2ee', dataKey: openedDataEncryptionKey }
      : { status: 'unavailable' };
  }

  if (
    typeof published !== 'string'
    || openedDataEncryptionKey === null
    || openedDataEncryptionKey.length !== 32
    || typeof params.machine.installationId !== 'string'
    || params.machine.installationId.length === 0
    || !params.expectedRunnerBinding
    || (
      expectedMode !== undefined
      && expectedMode !== 'e2ee'
    )
  ) return { status: 'unavailable' };

  const binding = RunnerMachineContentKeyBindingV1Schema.safeParse(
    params.machine.runnerContentKeyBinding,
  );
  const expected = params.expectedRunnerBinding;
  if (
    !binding.success
    || expected.machineId !== params.machine.id
    || binding.data.homeServerIdentityId !== expected.homeServerIdentityId
    || binding.data.creatorAccountId !== expected.creatorAccountId
    || binding.data.machineId !== expected.machineId
    || binding.data.installationId !== params.machine.installationId
    || binding.data.machineContentKeyFingerprint
      !== computeRunnerMachineContentKeyFingerprintV1(openedDataEncryptionKey)
  ) return { status: 'unavailable' };
  const authenticatedPayload = readRunnerMachineContentKeyBindingSignedPayloadV1(binding.data);
  const expectedAccountSigningPublicKey = expected.accountSigningPublicKeyBase64Url
    ?? (expected.accountScopedMaterial
      ? openRunnerMachineContentKeyVerifierFactV1({
        ciphertext: binding.data.creatorVerifierFactCiphertext,
        material: expected.accountScopedMaterial,
        expectedActivationId: binding.data.activationId,
        expectedMachineId: expected.machineId,
      })
      : null);
  if (!authenticatedPayload || !expectedAccountSigningPublicKey) return { status: 'unavailable' };
  const verified = verifyRunnerMachineContentKeyBindingV1({
    binding: binding.data,
    expectedPayload: authenticatedPayload,
    expectedAccountSigningPublicKey,
  });
  if (!verified) return { status: 'unavailable' };
  if (expected.sessionId !== undefined && !runnerClaimCorrespondsV1({
    claim: params.machine.runnerClaim,
    sessionId: expected.sessionId,
    activationId: binding.data.activationId,
    installationId: binding.data.installationId,
    activationSigningPublicKey: expectedAccountSigningPublicKey,
    expected,
  })) return { status: 'unavailable' };
  return { status: 'e2ee', dataKey: openedDataEncryptionKey };
}
