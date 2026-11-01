import {
  deriveAccountMachineKeyFromRecoverySecret,
  openEncryptedDataKeyEnvelopeV1,
  isPlainMachineDataKeyMarker,
} from '@happier-dev/protocol';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { resolveMachineEncryptionContext, type EncryptionContext } from '@/api/client/encryptionKey';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import type { Credentials } from '@/persistence';

import { fetchAccountMachine } from './fetchAccountMachine';
import { getAccountEncryptionMode } from '@/api/connectedServices/connectedServiceCredentialApi';

export type MachineRpcEncryptionErrorReason =
  | 'target_key_invalid'
  | 'target_key_unavailable'
  | 'response_invalid';

export class MachineRpcEncryptionError extends RpcError {
  constructor(readonly reason: MachineRpcEncryptionErrorReason) {
    super({
      target_key_invalid: 'The target machine published a malformed encryption key. Check the target daemon\'s encryption configuration before retrying.',
      target_key_unavailable: 'Cannot open the target machine\'s encryption key. The caller and target daemon must use matching account encryption keys.',
      response_invalid: 'Cannot decrypt the machine RPC response. The request may have run; check that the caller and target daemon use matching account encryption keys.',
    }[reason], 'MACHINE_RPC_ENCRYPTION_ERROR');
    this.name = 'MachineRpcEncryptionError';
  }
}

/** A published key is authoritative: never replace an unopenable key locally. */
export function openMachineDataEncryptionKey(params: Readonly<{
  credentials: Credentials;
  dataEncryptionKey: unknown;
}>): Uint8Array {
  if (typeof params.dataEncryptionKey !== 'string' || !params.dataEncryptionKey) {
    throw new MachineRpcEncryptionError('target_key_invalid');
  }
  let envelope: Uint8Array;
  try {
    envelope = decodeBase64(params.dataEncryptionKey);
  } catch {
    throw new MachineRpcEncryptionError('target_key_invalid');
  }
  if (encodeBase64(envelope) !== params.dataEncryptionKey) {
    throw new MachineRpcEncryptionError('target_key_invalid');
  }
  if (!params.credentials.encryption) throw new MachineRpcEncryptionError('target_key_unavailable');
  const recipientKey = params.credentials.encryption.type === 'dataKey'
    ? params.credentials.encryption.machineKey
    : deriveAccountMachineKeyFromRecoverySecret(params.credentials.encryption.secret);
  const opened = openEncryptedDataKeyEnvelopeV1({ envelope, recipientSecretKeyOrSeed: recipientKey });
  if (!opened || opened.length !== 32) throw new MachineRpcEncryptionError('target_key_unavailable');
  return opened;
}

export type MachineEncryptionContext = Pick<EncryptionContext, 'encryptionKey' | 'encryptionVariant'>
  | Readonly<{ encryptionKey: null; encryptionVariant: 'plain' }>;

/** The published row owns both storage and RPC encryption. */
export function resolvePublishedMachineEncryptionContext(credentials: Credentials, publishedKey: unknown, expectedAccountMode: 'plain' | 'e2ee' | 'unknown' = 'e2ee'): MachineEncryptionContext {
  if (typeof publishedKey === 'string' && isPlainMachineDataKeyMarker(publishedKey)) {
    if (expectedAccountMode !== 'plain') throw new MachineRpcEncryptionError('target_key_unavailable');
    return { encryptionKey: null, encryptionVariant: 'plain' };
  }
  if (publishedKey !== null && publishedKey !== undefined) {
    return { encryptionKey: openMachineDataEncryptionKey({ credentials, dataEncryptionKey: publishedKey }), encryptionVariant: 'dataKey' };
  }
  const { encryptionKey, encryptionVariant } = resolveMachineEncryptionContext(credentials);
  return { encryptionKey, encryptionVariant };
}

export async function resolveMachineRpcEncryption(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  timeoutMs?: number;
}>): Promise<MachineEncryptionContext> {
  const machine = await fetchAccountMachine(params);
  // Released relays and legacy machines may omit the published key. This is
  // their genuine credential-key path, never a fallback after a failed opener.
  const publishedKey = machine?.dataEncryptionKey;
  const expectedAccountMode = typeof publishedKey === 'string' && isPlainMachineDataKeyMarker(publishedKey)
    ? await getAccountEncryptionMode({ token: params.credentials.token, timeoutMs: params.timeoutMs })
    : 'e2ee';
  return resolvePublishedMachineEncryptionContext(params.credentials, publishedKey, expectedAccountMode);
}
