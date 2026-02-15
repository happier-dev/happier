import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import tweetnacl from 'tweetnacl';

import { decodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { readCredentials, writeCredentialsDataKey, writeCredentialsLegacy } from '@/persistence';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { decryptWithEphemeralKey } from '@/ui/auth';

type PendingAuthState = Readonly<{
  publicKey: string;
  secretKey: string;
  claimSecret: string;
  createdAt: string;
}>;

function pendingAuthStateDir(): string {
  return join(configuration.activeServerDir, 'auth', 'pending');
}

function pendingAuthStatePath(publicKey: Uint8Array): string {
  const publicKeyHex = createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 24);
  return join(pendingAuthStateDir(), `${publicKeyHex}.json`);
}

function decodePublicKey(value: string): Uint8Array {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Missing --public-key');
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
    throw new Error('Invalid --public-key (expected base64 or base64url encoded 32-byte key)');
  })();
}

function parsePendingAuthState(raw: string): PendingAuthState {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid auth state');
  const publicKey = (parsed as any).publicKey;
  const secretKey = (parsed as any).secretKey;
  const claimSecret = (parsed as any).claimSecret;
  const createdAt = (parsed as any).createdAt;
  if (typeof publicKey !== 'string') throw new Error('Invalid auth state (publicKey)');
  if (typeof secretKey !== 'string') throw new Error('Invalid auth state (secretKey)');
  if (typeof claimSecret !== 'string') throw new Error('Invalid auth state (claimSecret)');
  if (typeof createdAt !== 'string') throw new Error('Invalid auth state (createdAt)');
  return { publicKey, secretKey, claimSecret, createdAt };
}

export async function handleAuthWait(argsRaw: string[]): Promise<void> {
  const args = await applyServerSelectionFromArgs(argsRaw);

  const json = args.includes('--json');
  if (!json) {
    console.error('Missing required flag: --json');
    process.exit(2);
  }

  const keyIndex = args.findIndex((a) => a === '--public-key');
  const publicKeyRaw = keyIndex >= 0 ? (args[keyIndex + 1] ?? '') : '';
  if (!publicKeyRaw || String(publicKeyRaw).startsWith('--')) {
    console.error('Missing required flag: --public-key <base64>');
    process.exit(2);
  }

  const publicKeyBytes = decodePublicKey(String(publicKeyRaw));
  const statePath = pendingAuthStatePath(publicKeyBytes);
  const state = parsePendingAuthState(await readFile(statePath, 'utf8'));

  // If already authenticated, keep things idempotent (useful for scripts).
  const existing = await readCredentials();
  if (existing) {
    console.log(JSON.stringify({ success: true, token: existing.token, encryptionType: existing.encryption.type }));
    return;
  }

  const pollIntervalMsRaw = Number(process.env.HAPPIER_AUTH_POLL_INTERVAL_MS ?? '');
  const pollIntervalMs = Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0 ? pollIntervalMsRaw : 1000;

  while (true) {
    const statusRes = await axios.get(`${configuration.serverUrl}/v1/auth/request/status`, {
      params: { publicKey: state.publicKey },
    });
    const status = statusRes?.data?.status;
    if (status === 'not_found') {
      console.error('Authentication request expired. Run `happier auth request --json` again.');
      process.exit(1);
    }

    if (status === 'authorized') {
      const claimRes = await axios.post(`${configuration.serverUrl}/v1/auth/request/claim`, {
        publicKey: state.publicKey,
        claimSecret: state.claimSecret,
      });
      const claimData = claimRes?.data;
      if (claimData?.state !== 'authorized') {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      const token = String(claimData.token ?? '');
      const responseB64 = String(claimData.response ?? '');
      if (!token || !responseB64) {
        console.error('Unexpected response from server.');
        process.exit(1);
      }

      const decrypted = decryptWithEphemeralKey(decodeBase64(responseB64), decodeBase64(state.secretKey));
      if (!decrypted) {
        console.error('Failed to decrypt auth response.');
        process.exit(1);
      }

      if (decrypted.length === 32) {
        await writeCredentialsLegacy({ secret: decrypted, token });
        await unlink(statePath).catch(() => {});
        console.log(JSON.stringify({ success: true, token, encryptionType: 'legacy' as const }));
        return;
      }

      if (decrypted[0] === 0 && decrypted.length >= 33) {
        const machineKey = decrypted.slice(1, 33);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        await writeCredentialsDataKey({ publicKey, machineKey, token });
        await unlink(statePath).catch(() => {});
        console.log(JSON.stringify({ success: true, token, encryptionType: 'dataKey' as const }));
        return;
      }

      console.error('Auth response payload had an unsupported format.');
      process.exit(1);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

