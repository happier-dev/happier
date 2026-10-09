import type { StoredCredentials } from '@/persistence';

import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { isPlainMachineDataKeyMarker, resolvePublishedMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { AccountScopedCryptoMaterial, ExpectedRunnerMachineContentKeyBindingV1 } from '@happier-dev/protocol';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { decodeBase64, encodeBase64 } from '../encryption';
import {
  createMachineContentCodec,
  type MachineContentCodec,
  type MachineContentEncryptionContext,
} from './machineStoredContent';

export class MachineContentKeyUnavailableError extends Error {
  readonly code = 'machine_content_key_unavailable' as const;

  constructor(readonly machineId: string) {
    super(`Machine ${machineId} published a data encryption key this account cannot open`);
    this.name = 'MachineContentKeyUnavailableError';
  }
}

type PublishedMachineContentInput = Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  publishedDataEncryptionKey: unknown;
  expectedAccountMode: 'plain' | 'e2ee' | 'unknown';
  access?: unknown;
  machineKind?: 'persistent' | 'ephemeral_session_runner';
  installationId?: string | null;
  runnerContentKeyBinding?: unknown;
  /** Independently trusted Home/Account/Machine scope, never a published field. */
  expectedRunnerMachineContentKeyBinding?: ExpectedRunnerMachineContentKeyBindingScope;
}>;

export type ExpectedRunnerMachineContentKeyBindingScope = Pick<
  ExpectedRunnerMachineContentKeyBindingV1,
  'homeServerIdentityId' | 'creatorAccountId' | 'machineId'
>;

/**
 * The scope a daemon reader independently trusts for a Runner Machine key.
 *
 * Every credential kind that holds Account E2EE material qualifies: the
 * verifier identity itself is recovered from the creator-sealed fact on the
 * published binding, not derived from the credential, so a DataKey daemon
 * reaches the same proof a recovery-secret daemon does. A token-only daemon
 * holds no Account material and stays fail-closed.
 */
export function resolveExpectedRunnerMachineContentKeyBindingScope(params: Readonly<{
  credentials: StoredCredentials;
  homeServerIdentityId: string;
  machineId: string;
}>): ExpectedRunnerMachineContentKeyBindingScope | null {
  const homeServerIdentityId = params.homeServerIdentityId.trim();
  const machineId = params.machineId.trim();
  const accountId = readAccountIdFromToken(params.credentials.token);
  if (
    !homeServerIdentityId
    || !machineId
    || !accountId
    || !params.credentials.encryption
  ) return null;
  return {
    homeServerIdentityId,
    creatorAccountId: accountId,
    machineId,
  };
}

/**
 * A present Machine envelope names its content key. Account material only opens
 * that envelope; neither failed opening nor malformed presence permits fallback.
 * Genuine null/absence retains the released credential-specific Machine reader.
 */
export function resolvePublishedMachineEncryptionContext(
  params: PublishedMachineContentInput,
): MachineContentEncryptionContext {
  const published = params.publishedDataEncryptionKey;
  if (params.expectedAccountMode === 'unknown') {
    throw new MachineContentKeyUnavailableError(params.machineId);
  }
  const encryption = params.credentials.encryption;
  const accountScopedMaterial: AccountScopedCryptoMaterial | null = encryption?.type === 'dataKey'
    ? { type: 'dataKey', machineKey: encryption.machineKey }
    : encryption?.type === 'legacy'
      ? { type: 'legacy', secret: encryption.secret }
      : null;
  const accountContentSecret = encryption?.type === 'dataKey'
    ? encryption.machineKey
    : encryption?.type === 'legacy'
      ? deriveAccountMachineKeyFromRecoverySecret(encryption.secret)
      : null;
  const openedDataEncryptionKey =
    typeof published === 'string'
    && !isPlainMachineDataKeyMarker(published)
    && accountContentSecret
      ? openPublishedEnvelope(published, accountContentSecret)
      : null;
  const resolution = resolvePublishedMachineDataEncryptionKeyV1({
    machine: {
      id: params.machineId,
      kind: params.machineKind,
      installationId: params.installationId,
      dataEncryptionKey: published,
      access: params.access,
      runnerContentKeyBinding: params.runnerContentKeyBinding,
    },
    openedDataEncryptionKey,
    expectedAccountMode: params.expectedAccountMode,
    viewerAccountId: readAccountIdFromToken(params.credentials.token) ?? undefined,
    // The verifier identity is the creator's activation signing key, recovered
    // from the creator-sealed fact on the published binding. A daemon holds no
    // creator device custody, so Account material is the whole trust input.
    ...(params.expectedRunnerMachineContentKeyBinding && accountScopedMaterial
      ? {
          expectedRunnerBinding: {
            ...params.expectedRunnerMachineContentKeyBinding,
            accountScopedMaterial,
          },
        }
      : {}),
  });
  if (resolution.status === 'plain') return { encryptionMode: 'plain' };
  if (resolution.status === 'legacy' && encryption) {
    return encryption.type === 'legacy'
      ? { encryptionMode: 'e2ee', encryptionKey: encryption.secret, encryptionVariant: 'legacy' }
      : { encryptionMode: 'e2ee', encryptionKey: encryption.machineKey, encryptionVariant: 'dataKey' };
  }
  if (resolution.status === 'e2ee') {
    return {
      encryptionMode: 'e2ee',
      encryptionKey: resolution.dataKey,
      encryptionVariant: 'dataKey',
    };
  }
  throw new MachineContentKeyUnavailableError(params.machineId);
}

export function resolvePublishedMachineContentCodec(params: PublishedMachineContentInput): MachineContentCodec {
  return createMachineContentCodec(resolvePublishedMachineEncryptionContext(params));
}

function openPublishedEnvelope(
  published: string,
  accountContentSecret: Uint8Array,
): Uint8Array | null {
  try {
    const envelope = decodeBase64(published);
    if (encodeBase64(envelope) !== published) return null;
    return openEncryptedDataKeyEnvelopeV1({
      envelope,
      recipientSecretKeyOrSeed: accountContentSecret,
    });
  } catch {
    return null;
  }
}
