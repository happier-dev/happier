import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import tweetnacl from 'tweetnacl';

import { decodeBase64 } from '@/api/encryption';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import {
  readStoredCredentials,
  writeCredentialsDataKey,
  writeCredentialsLegacy,
  writeCredentialsTokenOnly,
  type Credentials,
  type StoredCredentials,
} from '@/persistence';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { ensureMachineIdForCredentials } from '@/ui/auth';
import {
  openTerminalProvisioningResponse,
  readTerminalPairingRequirement,
  type TerminalPairingRequirement,
} from '@/auth/terminalProvisioningResponse';

type PendingAuthState = Readonly<{
  publicKey: string;
  secretKey: string;
  claimSecret: string;
  pairingSecret?: string;
  pairingCreatedAtMs?: number;
  pairingExpiresAtMs?: number;
  supportsTokenOnly?: true;
  pairingRequirement?: TerminalPairingRequirement;
  createdAt: string;
}>;

const V3_REQUIRED_ERROR =
  'Authenticated terminal pairing v3 is required. Update the Happier mobile app and scan a new QR code.';

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
  const pairingSecret = (parsed as any).pairingSecret;
  const pairingCreatedAtMs = (parsed as any).pairingCreatedAtMs;
  const pairingExpiresAtMs = (parsed as any).pairingExpiresAtMs;
  const supportsTokenOnly = (parsed as any).supportsTokenOnly;
  const pairingRequirement = (parsed as any).pairingRequirement;
  if (typeof publicKey !== 'string') throw new Error('Invalid auth state (publicKey)');
  if (typeof secretKey !== 'string') throw new Error('Invalid auth state (secretKey)');
  if (typeof claimSecret !== 'string') throw new Error('Invalid auth state (claimSecret)');
  if (typeof createdAt !== 'string') throw new Error('Invalid auth state (createdAt)');
  if (pairingRequirement !== undefined && pairingRequirement !== 'v3') {
    throw new Error('Invalid auth state (pairingRequirement)');
  }
  const hasValidPairing =
    typeof pairingSecret === 'string'
    && Number.isSafeInteger(pairingCreatedAtMs)
    && Number.isSafeInteger(pairingExpiresAtMs)
    && pairingCreatedAtMs >= 0
    && pairingExpiresAtMs > pairingCreatedAtMs;
  return {
    publicKey,
    secretKey,
    claimSecret,
    createdAt,
    ...(hasValidPairing ? { pairingSecret, pairingCreatedAtMs, pairingExpiresAtMs } : {}),
    ...(hasValidPairing && supportsTokenOnly === true ? { supportsTokenOnly: true } : {}),
    ...(pairingRequirement === 'v3' ? { pairingRequirement } : {}),
  };
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
  const pairingRequirement = state.pairingRequirement ?? readTerminalPairingRequirement();
  const pairing =
    state.pairingSecret !== undefined
    && state.pairingCreatedAtMs !== undefined
    && state.pairingExpiresAtMs !== undefined
      ? {
          secret: decodeBase64(state.pairingSecret, 'base64url'),
          createdAtMs: state.pairingCreatedAtMs,
          expiresAtMs: state.pairingExpiresAtMs,
        }
      : null;
  // If already authenticated, keep things idempotent (useful for scripts).
  const existing = await readStoredCredentials();
  if (existing) {
    const { machineId } = await ensureMachineIdForCredentials(existing);
    await writeJsonStdout({
      success: true,
      token: existing.token,
      encryptionType: existing.encryption?.type ?? 'tokenOnly',
      machineId,
    });
    return;
  }
  if (pairingRequirement === 'v3' && !pairing) {
    console.error(`${V3_REQUIRED_ERROR} Run \`happier auth request --json\` again.`);
    process.exit(1);
  }

  const pollIntervalMsRaw = Number(process.env.HAPPIER_AUTH_POLL_INTERVAL_MS ?? '');
  const pollIntervalMs = Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0 ? pollIntervalMsRaw : 1000;

  while (true) {
    const statusRes = await axios.get(`${configuration.apiServerUrl}/v1/auth/request/status`, {
      params: { publicKey: state.publicKey },
    });
    const status = statusRes?.data?.status;
    if (status === 'not_found') {
      console.error('Authentication request expired. Run `happier auth request --json` again.');
      process.exit(1);
    }

    if (status === 'authorized') {
      const claimRes = await axios.post(`${configuration.apiServerUrl}/v1/auth/request/claim`, {
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

      const terminalSecretKey = decodeBase64(state.secretKey);
      const opened = openTerminalProvisioningResponse({
        payload: decodeBase64(responseB64),
        terminalSecretKey,
        terminalPublicKey: publicKeyBytes,
        pairing,
        requirement: pairingRequirement,
        nowMs: Date.now(),
        supportsTokenOnly: state.supportsTokenOnly === true,
      });
      if (!opened) {
        console.error(
          pairingRequirement === 'v3'
            ? V3_REQUIRED_ERROR
            : 'Failed to decrypt auth response.',
        );
        process.exit(1);
      }

      if (opened.type === 'legacy') {
        await writeCredentialsLegacy({ secret: opened.key, token });
        const credentials: Credentials = {
          token,
          encryption: {
            type: 'legacy',
            secret: opened.key,
          },
        };
        const { machineId } = await ensureMachineIdForCredentials(credentials);
        await unlink(statePath).catch(() => {});
        await writeJsonStdout({
          success: true,
          token,
          encryptionType: 'legacy' as const,
          pairingAuthentication: opened.authenticated ? 'v3' : 'legacy',
          machineId,
        });
        return;
      }

      if (opened.type === 'dataKey') {
        const machineKey = opened.key;
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        await writeCredentialsDataKey({ publicKey, machineKey, token });
        const credentials: Credentials = {
          token,
          encryption: {
            type: 'dataKey',
            publicKey,
            machineKey,
          },
        };
        const { machineId } = await ensureMachineIdForCredentials(credentials);
        await unlink(statePath).catch(() => {});
        await writeJsonStdout({
          success: true,
          token,
          encryptionType: 'dataKey' as const,
          pairingAuthentication: opened.authenticated ? 'v3' : 'legacy',
          machineId,
        });
        return;
      }

      await writeCredentialsTokenOnly({ token });
      const credentials: StoredCredentials = {
        token,
        encryption: null,
      };
      const { machineId } = await ensureMachineIdForCredentials(credentials);
      await unlink(statePath).catch(() => {});
      await writeJsonStdout({
        success: true,
        token,
        encryptionType: 'tokenOnly' as const,
        pairingAuthentication: 'v3' as const,
        machineId,
      });
      return;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
