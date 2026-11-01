import { randomBytes } from 'node:crypto';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import {
  AccountKeyProvisioningUnavailableError,
  assertAccountKeyProvisioningAllowed,
  deriveAccountMachineKeyFromRecoverySecret,
  sealTerminalProvisioningV2TokenOnlyPayload,
  UserResponseSchema,
} from '@happier-dev/protocol';

import { getAccountEncryptionMode } from '@/api/connectedServices/connectedServiceCredentialApi';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { readCredentials, type Credentials } from '@/persistence';

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

function buildApprovalPayload(encryption: NonNullable<Credentials['encryption']>): Uint8Array {
  const machineKey =
    encryption.type === 'legacy'
      ? deriveAccountMachineKeyFromRecoverySecret(encryption.secret)
      : encryption.machineKey;

  const plaintext = new Uint8Array(33);
  plaintext[0] = 0;
  plaintext.set(machineKey, 1);
  return plaintext;
}

export async function approveTerminalAuthRequest(params: Readonly<{ publicKey: string }>): Promise<void> {
  const recipientPk = decodePublicKey(params.publicKey);
  const creds = await readCredentials();
  if (!creds) {
    throw new Error('Not authenticated. Run `happier auth login` first.');
  }
  const mode = await getAccountEncryptionMode({ token: creds.token });
  if (mode === 'unknown') throw new AccountKeyProvisioningUnavailableError();
  if (!creds.encryption) {
    if (mode !== 'plain') throw new AccountKeyProvisioningUnavailableError();
    const statusResponse = await axios.get<unknown>(`${configuration.apiServerUrl}/v1/auth/request/status`, {
      params: { publicKey: encodePublicKeyBase64(recipientPk) },
    });
    const status = statusResponse.data;
    if (!status || typeof status !== 'object' || !('supportsTokenOnly' in status) || status.supportsTokenOnly !== true) {
      throw Object.assign(new Error('This terminal cannot receive token-only credentials. Update the terminal and request authentication again.'), {
        code: 'terminal_credential_variant_unsupported',
      });
    }
  } else if (mode === 'e2ee') {
    const subject = decodeJwtPayload(creds.token)?.sub;
    const accountId = typeof subject === 'string' ? subject.trim() : '';
    if (!accountId) throw new AccountKeyProvisioningUnavailableError();
    const profileResponse = await axios.get<unknown>(
      `${configuration.apiServerUrl}/v1/user/${encodeURIComponent(accountId)}`,
      { headers: { Authorization: `Bearer ${creds.token}` } },
    );
    const parsed = UserResponseSchema.safeParse(profileResponse.data);
    if (!parsed.success || parsed.data.user.id !== accountId) throw new AccountKeyProvisioningUnavailableError();
    assertAccountKeyProvisioningAllowed({ mode, account: parsed.data.user, material: creds.encryption });
  }
  const response = creds.encryption
    ? encryptForTerminal(recipientPk, buildApprovalPayload(creds.encryption))
    : Buffer.from(sealTerminalProvisioningV2TokenOnlyPayload({ recipientPublicKey: recipientPk, randomBytes })).toString('base64');

  await axios.post(
    `${configuration.apiServerUrl}/v1/auth/response`,
    { publicKey: encodePublicKeyBase64(recipientPk), response },
    { headers: { Authorization: `Bearer ${creds.token}` } },
  );
}
