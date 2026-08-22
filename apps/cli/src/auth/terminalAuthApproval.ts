import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { randomBytes } from 'node:crypto';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readStoredCredentials, type Credentials } from '@/persistence';

export class TokenOnlyTerminalApprovalUpgradeRequiredError extends Error {
  readonly code = 'TOKEN_ONLY_TERMINAL_APPROVAL_UPGRADE_REQUIRED' as const;

  constructor() {
    super(
      'Token-only CLI-to-remote pairing requires a newer terminal approval protocol. '
      + 'Upgrade both CLIs when support is available, or approve from a device with Account encryption material.',
    );
    this.name = 'TokenOnlyTerminalApprovalUpgradeRequiredError';
  }
}

function decodePublicKey(value: string): Uint8Array {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Missing public key');
  const tryBase64 = (enc: BufferEncoding): Uint8Array | null => {
    try {
      const buf = Buffer.from(raw, enc);
      if (buf.length !== tweetnacl.box.publicKeyLength) return null;
      return new Uint8Array(buf);
    } catch {
      return null;
    }
  };
  return tryBase64('base64') ?? tryBase64('base64url') ?? (() => {
    throw new Error('Invalid public key (expected base64 or base64url encoded 32-byte key)');
  })();
}

function encodePublicKeyBase64(pk: Uint8Array): string {
  return Buffer.from(pk).toString('base64');
}

function encryptForTerminal(recipientPublicKey: Uint8Array, plaintext: Uint8Array): string {
  const ephemeral = tweetnacl.box.keyPair();
  const nonce = randomBytes(tweetnacl.box.nonceLength);
  const cipher = tweetnacl.box(plaintext, nonce, recipientPublicKey, ephemeral.secretKey);
  const bundle = Buffer.concat([Buffer.from(ephemeral.publicKey), Buffer.from(nonce), Buffer.from(cipher)]);
  return bundle.toString('base64');
}

function buildApprovalPayload(creds: Credentials): Uint8Array {
  const machineKey =
    creds.encryption.type === 'legacy'
      ? deriveAccountMachineKeyFromRecoverySecret(creds.encryption.secret)
      : creds.encryption.machineKey;

  const plaintext = new Uint8Array(33);
  plaintext[0] = 0;
  plaintext.set(machineKey, 1);
  return plaintext;
}

export async function approveTerminalAuthRequest(params: Readonly<{ publicKey: string }>): Promise<void> {
  const recipientPk = decodePublicKey(params.publicKey);
  const creds = await readStoredCredentials();
  if (!creds) {
    throw new Error('Not authenticated. Run `happier auth login` first.');
  }
  if (!creds.encryption) {
    throw new TokenOnlyTerminalApprovalUpgradeRequiredError();
  }
  const response = encryptForTerminal(recipientPk, buildApprovalPayload(creds));

  await axios.post(
    `${configuration.apiServerUrl}/v1/auth/response`,
    { publicKey: encodePublicKeyBase64(recipientPk), response },
    { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${creds.token}` } },
  );
}
