import { createHash, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';

import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import {
  createTerminalPairingAuthentication,
  openTerminalProvisioningResponse,
} from '@/auth/terminalProvisioningResponse';
import {
  claimTerminalAuthRequest,
  createTerminalAuthRequest,
  readTerminalAuthRequestStatus,
  verifyTerminalAuthEnrollmentRuntime,
} from '@/auth/terminalAuthEnrollmentClient';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import {
  persistTerminalEnrollmentCredential,
  registerTerminalEnrollmentMachine,
} from '@/auth/persistTerminalEnrollmentCredential';
import {
  fetchServerFeaturesSnapshot,
  observeServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';

const MAX_PROVISIONING_RESPONSE_B64_CHARS = 4096;

export type RemoteTerminalEnrollmentPairingRequest = Readonly<{
  publicKey: string;
  homeServerIdentityId: string;
  pairing: Readonly<{
    secretB64Url: string;
    createdAtMs: number;
    expiresAtMs: number;
  }>;
  supportsTokenOnly: true;
  pairingRequirement: 'v3';
}>;

export type RemoteTerminalEnrollmentResult = Readonly<{
  success: true;
  homeServerIdentityId: string;
  machineId: string;
  encryptionType: 'dataKey' | 'tokenOnly';
  pairingAuthentication: 'v3';
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function remainingMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

function throwIfStopped(signal: AbortSignal | undefined, deadlineMs: number): void {
  if (signal?.aborted) {
    throw new Error('Remote Home enrollment was cancelled.');
  }
  if (Date.now() >= deadlineMs) {
    throw new Error('Remote Home enrollment timed out.');
  }
}

async function delayWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, ms);
    const onAbort = () => finish(new Error('Remote Home enrollment was cancelled.'));
    function finish(error?: Error): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * SSH automation's canonical terminal enrollment owner. Ephemeral key, claim,
 * and v3 pairing secrets never leave this process. Only the short-lived v3
 * approval context is emitted, and only the final Home credential is persisted.
 */
export async function runRemoteTerminalEnrollment(params: Readonly<{
  target: ResolvedHomeTarget;
  signal?: AbortSignal;
  timeoutMs: number;
  pollIntervalMs?: number;
  onPairingRequest(request: RemoteTerminalEnrollmentPairingRequest): Promise<void> | void;
}>): Promise<RemoteTerminalEnrollmentResult> {
  const deadlineMs = Date.now() + Math.max(1, Math.floor(params.timeoutMs));
  const pollIntervalMs = Math.max(1, Math.floor(params.pollIntervalMs ?? 500));
  throwIfStopped(params.signal, deadlineMs);

  const acquired = await acquireTerminalAuthEnrollmentRuntime(
    params.target.descriptor ?? params.target,
    params.target.preferredTransport,
    params.signal,
  );
  if (!acquired.ok) {
    throw new Error('Unable to acquire the selected Home enrollment carrier.');
  }

  try {
    throwIfStopped(params.signal, deadlineMs);
    const initialSnapshot = await fetchServerFeaturesSnapshot({
      serverUrl: acquired.runtime.runtimeOrigin,
      timeoutMs: remainingMs(deadlineMs),
      signal: params.signal,
    });
    const verified = verifyTerminalAuthEnrollmentRuntime({
      target: params.target,
      runtime: acquired.runtime,
      snapshot: initialSnapshot,
    });

    const secretKey = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secretKey);
    const claimSecret = new Uint8Array(randomBytes(32));
    const claimSecretB64Url = Buffer.from(claimSecret).toString('base64url');
    const claimSecretHash = createHash('sha256').update(Buffer.from(claimSecret)).digest('base64url');
    const pairing = createTerminalPairingAuthentication({
      nowMs: Date.now(),
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });
    const publicKey = encodeBase64(keypair.publicKey);

    await createTerminalAuthRequest({
      runtime: acquired.runtime,
      publicKey,
      supportsV2: true,
      claimSecretHash,
      headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      timeoutMs: remainingMs(deadlineMs),
      signal: params.signal,
    });
    await params.onPairingRequest({
      publicKey,
      homeServerIdentityId: verified.homeServerIdentityId,
      pairing: {
        secretB64Url: Buffer.from(pairing.secret).toString('base64url'),
        createdAtMs: pairing.createdAtMs,
        expiresAtMs: pairing.expiresAtMs,
      },
      supportsTokenOnly: true,
      pairingRequirement: 'v3',
    });

    while (true) {
      throwIfStopped(params.signal, deadlineMs);
      const statusData = await readTerminalAuthRequestStatus({
        runtime: acquired.runtime,
        publicKey,
        headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        timeoutMs: remainingMs(deadlineMs),
        signal: params.signal,
      });
      const status = isRecord(statusData) ? statusData.status : undefined;
      if (status === 'not_found') {
        throw new Error('Remote Home enrollment request expired.');
      }
      if (status !== 'authorized') {
        await delayWithSignal(Math.min(pollIntervalMs, remainingMs(deadlineMs)), params.signal);
        continue;
      }

      const claimData = await claimTerminalAuthRequest({
        runtime: acquired.runtime,
        publicKey,
        claimSecret: claimSecretB64Url,
        headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        timeoutMs: remainingMs(deadlineMs),
        signal: params.signal,
      });
      if (!isRecord(claimData) || claimData.state !== 'authorized') {
        await delayWithSignal(Math.min(pollIntervalMs, remainingMs(deadlineMs)), params.signal);
        continue;
      }
      const claimedIdentity = typeof claimData.serverIdentityId === 'string'
        ? claimData.serverIdentityId.trim()
        : '';
      if (claimedIdentity !== verified.homeServerIdentityId) {
        throw new Error('Remote Home enrollment response identity does not match the selected Home.');
      }
      const token = typeof claimData.token === 'string' ? claimData.token : '';
      const responseB64 = typeof claimData.response === 'string' ? claimData.response : '';
      if (!token || !responseB64 || responseB64.length > MAX_PROVISIONING_RESPONSE_B64_CHARS) {
        throw new Error('Remote Home enrollment returned an invalid provisioning response.');
      }
      const authenticatedSnapshot = await observeServerFeaturesSnapshot({
        serverUrl: acquired.runtime.runtimeOrigin,
        token,
        timeoutMs: remainingMs(deadlineMs),
        signal: params.signal,
      });
      verifyTerminalAuthEnrollmentRuntime({
        target: params.target,
        runtime: acquired.runtime,
        snapshot: authenticatedSnapshot,
      });
      const opened = openTerminalProvisioningResponse({
        payload: decodeBase64(responseB64),
        terminalSecretKey: keypair.secretKey,
        terminalPublicKey: keypair.publicKey,
        pairing,
        nowMs: Date.now(),
        supportsTokenOnly: true,
      });
      if (!opened) {
        throw new Error('Authenticated terminal pairing v3 is required.');
      }
      const persisted = await persistTerminalEnrollmentCredential({ token, opened });
      const machineId = await registerTerminalEnrollmentMachine(
        persisted.credentials,
        acquired.runtime.runtimeOrigin,
      );
      return {
        success: true,
        homeServerIdentityId: verified.homeServerIdentityId,
        machineId,
        encryptionType: persisted.encryptionType,
        pairingAuthentication: 'v3',
      };
    }
  } finally {
    await acquired.close();
  }
}
