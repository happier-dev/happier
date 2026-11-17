import { createHash } from 'node:crypto';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import { MachineEnrollmentCorrelationV1Schema, type MachineEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import { MachinePublishedMetadataV1Schema, DeploymentAppMachineBindingV1Schema, type DeploymentAppMachineBindingV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

import { decodeBase64 } from '@/api/encryption';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import {
  persistTerminalEnrollmentCredential,
  registerAndPersistManagedTerminalEnrollmentCredential,
  registerTerminalEnrollmentMachine,
} from '@/auth/persistTerminalEnrollmentCredential';
import {
  openTerminalProvisioningResponse,
} from '@/auth/terminalProvisioningResponse';
import {
  readProtectedLocalStateFile,
  removeProtectedLocalStateFile,
} from '@/utils/fs/protectedLocalState';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import {
  claimTerminalAuthRequest,
  readTerminalAuthRequestStatus,
  verifyTerminalAuthEnrollmentRuntime,
} from '@/auth/terminalAuthEnrollmentClient';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { useServerProfile } from '@/server/serverProfiles';
import { retryHomeOperation, TERMINAL_AUTH_POLL_INTERVAL_MS, type HomeOperationRetry } from '@/api/client/retryHomeOperation';

type PendingAuthState = Readonly<{
  publicKey: string;
  secretKey: string;
  claimSecret: string;
  serverIdentityId: string;
  pairingSecret: string;
  pairingCreatedAtMs: number;
  pairingExpiresAtMs: number;
  supportsTokenOnly: true;
  pairingRequirement: 'v3';
  homeConnectionDescriptor?: HomeConnectionDescriptorV1;
  managedEnrollment?: MachineEnrollmentCorrelationV1;
  machineDisplayName?: string;
  deploymentAppBinding?: DeploymentAppMachineBindingV1;
  remoteProfileId?: string;
  createdAt: string;
}>;

const V3_REQUIRED_ERROR =
  'Authenticated terminal pairing v3 is required. Update the Happier mobile app and scan a new QR code.';

class AuthWaitError extends Error {
  constructor(readonly code: 'AUTH_WAIT_INVALID_ARGUMENT' | 'AUTH_WAIT_INVALID_STATE' | 'AUTH_WAIT_TRANSPORT_UNAVAILABLE'
    | 'AUTH_REQUEST_EXPIRED' | 'AUTH_RESPONSE_HOME_MISMATCH' | 'AUTH_RESPONSE_INVALID' | 'AUTH_PAIRING_V3_REQUIRED', message: string) {
    super(message);
    this.name = 'AuthWaitError';
  }
}

// Bound the claim response before decoding: legitimate v3 payloads are ~141
// bytes (188 base64 chars), so anything beyond this is malformed server input.
const MAX_PROVISIONING_RESPONSE_B64_CHARS = 4096;
const PENDING_AUTH_STATE_PROTECTION = { authority: 'owned' } as const;

function pendingAuthStateDir(): string {
  return join(configuration.activeServerDir, 'auth', 'pending');
}

function pendingAuthStatePath(publicKey: Uint8Array): string {
  const publicKeyHex = createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 24);
  return join(pendingAuthStateDir(), `${publicKeyHex}.json`);
}

function decodePublicKey(value: string): Uint8Array {
  const raw = String(value ?? '').trim();
  if (!raw) throw new AuthWaitError('AUTH_WAIT_INVALID_ARGUMENT', 'Missing --public-key');
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
    throw new AuthWaitError('AUTH_WAIT_INVALID_ARGUMENT', 'Invalid --public-key (expected base64 or base64url encoded 32-byte key)');
  })();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasCanonicalEncodedLength(
  value: string,
  encoding: 'base64' | 'base64url',
  expectedLength: number,
): boolean {
  try {
    const decoded = Buffer.from(value, encoding);
    return decoded.length === expectedLength && decoded.toString(encoding) === value;
  } catch {
    return false;
  }
}

function parsePendingAuthState(raw: string): PendingAuthState {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('Invalid auth state');
  const {
    publicKey,
    secretKey,
    claimSecret,
    serverIdentityId,
    createdAt,
    pairingSecret,
    pairingCreatedAtMs,
    pairingExpiresAtMs,
    supportsTokenOnly,
    pairingRequirement,
    homeConnectionDescriptor,
  } = parsed;
  if (typeof publicKey !== 'string' || !hasCanonicalEncodedLength(publicKey, 'base64', 32)) {
    throw new Error('Invalid auth state (publicKey)');
  }
  if (typeof secretKey !== 'string' || !hasCanonicalEncodedLength(secretKey, 'base64', 32)) {
    throw new Error('Invalid auth state (secretKey)');
  }
  if (typeof claimSecret !== 'string' || !hasCanonicalEncodedLength(claimSecret, 'base64url', 32)) {
    throw new Error('Invalid auth state (claimSecret)');
  }
  if (typeof createdAt !== 'string') throw new Error('Invalid auth state (createdAt)');
  const normalizedServerIdentityId = normalizeServerIdentityIdCapability(serverIdentityId);
  if (!normalizedServerIdentityId) throw new Error('Invalid auth state (serverIdentityId)');
  if (supportsTokenOnly !== true) {
    throw new Error('Invalid auth state (supportsTokenOnly)');
  }
  if (pairingRequirement !== 'v3') {
    throw new Error('Invalid auth state (pairingRequirement)');
  }
  const parsedDescriptor = homeConnectionDescriptor === undefined
    ? undefined
    : HomeConnectionDescriptorV1Schema.safeParse(homeConnectionDescriptor);
  if (parsedDescriptor && !parsedDescriptor.success) {
    throw new Error('Invalid auth state (homeConnectionDescriptor)');
  }
  if (parsedDescriptor?.success && parsedDescriptor.data.homeServerIdentityId !== normalizedServerIdentityId) {
    throw new Error('Invalid auth state (homeConnectionDescriptor identity)');
  }
  const managedEnrollment = parsed.managedEnrollment === undefined ? undefined
    : MachineEnrollmentCorrelationV1Schema.parse(parsed.managedEnrollment);
  if (managedEnrollment && (!parsedDescriptor?.success || managedEnrollment.homeId !== normalizedServerIdentityId)) {
    throw new Error('Invalid auth state (managed enrollment Home)');
  }
  const remoteProfileId = parsed.remoteProfileId;
  if (remoteProfileId !== undefined && (typeof remoteProfileId !== 'string' || !remoteProfileId.trim())) {
    throw new Error('Invalid auth state (remote profile)');
  }

  if (typeof pairingSecret !== 'string' || !hasCanonicalEncodedLength(pairingSecret, 'base64url', 32)) {
    throw new Error('Invalid auth state (pairingSecret)');
  }
  if (typeof pairingCreatedAtMs !== 'number' || !Number.isSafeInteger(pairingCreatedAtMs) || pairingCreatedAtMs < 0) {
    throw new Error('Invalid auth state (pairingCreatedAtMs)');
  }
  if (
    typeof pairingExpiresAtMs !== 'number'
    || !Number.isSafeInteger(pairingExpiresAtMs)
    || pairingExpiresAtMs <= pairingCreatedAtMs
  ) {
    throw new Error('Invalid auth state (pairingExpiresAtMs)');
  }

  return {
    publicKey,
    secretKey,
    claimSecret,
    serverIdentityId: normalizedServerIdentityId,
    createdAt,
    pairingSecret,
    pairingCreatedAtMs,
    pairingExpiresAtMs,
    supportsTokenOnly: true,
    pairingRequirement: 'v3',
    ...(parsedDescriptor?.success ? { homeConnectionDescriptor: parsedDescriptor.data } : {}),
    ...(managedEnrollment ? { managedEnrollment } : {}),
    ...(parsed.deploymentAppBinding !== undefined ? { deploymentAppBinding: DeploymentAppMachineBindingV1Schema.parse(parsed.deploymentAppBinding) } : {}),
    ...(parsed.machineDisplayName !== undefined ? {
      machineDisplayName: MachinePublishedMetadataV1Schema.shape.displayName.parse(parsed.machineDisplayName),
    } : {}),
    ...(typeof remoteProfileId === 'string' ? { remoteProfileId } : {}),
  };
}

async function completeClaimedCredentialHandoff(params: Readonly<{
  credentials: StoredCredentials;
  statePath: string;
  runtimeOrigin: string;
  homeRetry: HomeOperationRetry;
}>): Promise<string> {
  // The relay claim is one-shot. Once credentials are durable, this request
  // must no longer be retryable even if the subsequent registration fails.
  await removeProtectedLocalStateFile(params.statePath, PENDING_AUTH_STATE_PROTECTION);
  try {
    return await registerTerminalEnrollmentMachine(params.credentials, params.runtimeOrigin, undefined, params.homeRetry);
  } catch (cause) {
    throw new Error(
      'Authentication credentials were saved, but machine registration is incomplete. '
      + 'Run `happier auth login` to retry machine setup.',
      { cause },
    );
  }
}

function waitForPollInterval(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export async function handleAuthWait(argsRaw: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const args = await applyServerSelectionFromArgs(argsRaw);

  const json = args.includes('--json');
  if (!json) {
    throw new AuthWaitError('AUTH_WAIT_INVALID_ARGUMENT', 'Missing required flag: --json');
  }

  const keyIndex = args.findIndex((a) => a === '--public-key');
  const publicKeyRaw = keyIndex >= 0 ? (args[keyIndex + 1] ?? '') : '';
  if (!publicKeyRaw || String(publicKeyRaw).startsWith('--')) {
    throw new AuthWaitError('AUTH_WAIT_INVALID_ARGUMENT', 'Missing required flag: --public-key <base64>');
  }

  const publicKeyBytes = decodePublicKey(String(publicKeyRaw));
  const statePath = pendingAuthStatePath(publicKeyBytes);
  const rawState = await readProtectedLocalStateFile(statePath, PENDING_AUTH_STATE_PROTECTION);
  let state: PendingAuthState;
  try { state = parsePendingAuthState(rawState); } catch {
    throw new AuthWaitError('AUTH_WAIT_INVALID_STATE', 'Invalid pending authentication state. Request fresh approval.');
  }
  const remoteEnrollment = args.includes('--remote-enrollment');
  if (remoteEnrollment && (!state.remoteProfileId || state.remoteProfileId !== configuration.activeServerId)) {
    throw new AuthWaitError('AUTH_WAIT_INVALID_STATE', 'Remote enrollment requires its exact prepared Home profile.');
  }
  const pairing = {
    secret: decodeBase64(state.pairingSecret, 'base64url'),
    createdAtMs: state.pairingCreatedAtMs,
    expiresAtMs: state.pairingExpiresAtMs,
  };
  const selectedTarget = state.homeConnectionDescriptor
    ? await resolveCliHomeTarget({
        kind: 'descriptor',
        descriptor: state.homeConnectionDescriptor,
        authority: 'trusted_enrollment',
      })
    : await resolveCurrentCliHomeTarget();
  const target = selectedTarget.descriptor
    ? selectedTarget
    : await resolveCliHomeTarget({ kind: 'https_url', url: configuration.apiServerUrl });
  const acquired = await acquireTerminalAuthEnrollmentRuntime(
    target.descriptor ?? target, target.preferredTransport, signal,
  );
  if (!acquired.ok) throw Object.assign(new AuthWaitError('AUTH_WAIT_TRANSPORT_UNAVAILABLE', 'Unable to acquire the selected Home enrollment carrier'),
    { cause: acquired.error, carrierFailure: acquired.carrierFailure });
  const pollIntervalMsRaw = Number(process.env.HAPPIER_AUTH_POLL_INTERVAL_MS ?? '');
  const pollIntervalMs = Number.isFinite(pollIntervalMsRaw) && pollIntervalMsRaw > 0 ? pollIntervalMsRaw : TERMINAL_AUTH_POLL_INTERVAL_MS;
  const homeRetry = { deadlineMs: state.pairingExpiresAtMs, pollIntervalMs, signal };

  try {
    if (target.descriptor) {
      const initialSnapshot = await fetchServerFeaturesSnapshot({ serverUrl: acquired.runtime.runtimeOrigin, ...(signal ? { signal } : {}) });
      verifyTerminalAuthEnrollmentRuntime({ target, runtime: acquired.runtime, snapshot: initialSnapshot, phase: 'first_contact' });
    }
    while (true) {
    signal?.throwIfAborted();
    if (Date.now() >= state.pairingExpiresAtMs) {
      throw new AuthWaitError('AUTH_REQUEST_EXPIRED', 'Authentication request expired. Run `happier auth request --json` again.');
    }
    const statusData = await readTerminalAuthRequestStatus({ runtime: acquired.runtime, publicKey: state.publicKey, ...(signal ? { signal } : {}) });
    const status = isRecord(statusData) ? statusData.status : undefined;
    if (status === 'not_found') {
      throw new AuthWaitError('AUTH_REQUEST_EXPIRED', 'Authentication request expired. Run `happier auth request --json` again.');
    }
    if (status !== 'pending' && status !== 'authorized') {
      throw new AuthWaitError('AUTH_RESPONSE_INVALID', 'Unexpected authentication request status from server.');
    }

    if (status === 'authorized') {
      const claimData = await claimTerminalAuthRequest({
        runtime: acquired.runtime,
        publicKey: state.publicKey,
        claimSecret: state.claimSecret,
        ...(signal ? { signal } : {}),
      });
      if (!isRecord(claimData) || claimData.state !== 'authorized') {
        if (!isRecord(claimData) || claimData.state !== 'requested') {
          throw new AuthWaitError('AUTH_RESPONSE_INVALID', 'Unexpected authentication claim response from server.');
        }
        await waitForPollInterval(pollIntervalMs, signal);
        continue;
      }
      const claimedServerIdentityId = normalizeServerIdentityIdCapability(claimData.serverIdentityId);
      if (claimedServerIdentityId !== state.serverIdentityId) {
        throw new AuthWaitError('AUTH_RESPONSE_HOME_MISMATCH',
          `The authentication response came from a different Home identity `
          + `(expected ${state.serverIdentityId}, received ${claimedServerIdentityId ?? 'missing'}). `
          + 'Credentials were not changed; create a new request for the intended Home.',
        );
      }
      const token = String(claimData.token ?? '');
      const responseB64 = String(claimData.response ?? '');
      if (!token || !responseB64 || responseB64.length > MAX_PROVISIONING_RESPONSE_B64_CHARS) {
        throw new AuthWaitError('AUTH_RESPONSE_INVALID', 'Unexpected response from server.');
      }
      if (target.descriptor) {
        await retryHomeOperation(homeRetry, async () => {
          const authenticatedSnapshot = await fetchServerFeaturesSnapshot({
            serverUrl: acquired.runtime.runtimeOrigin,
            token,
            timeoutMs: Math.max(1, homeRetry.deadlineMs - Date.now()),
            ...(signal ? { signal } : {}),
          });
          verifyTerminalAuthEnrollmentRuntime({ target, runtime: acquired.runtime, snapshot: authenticatedSnapshot, phase: 'post_claim' });
        });
      }

      const terminalSecretKey = decodeBase64(state.secretKey);
      if (Date.now() >= state.pairingExpiresAtMs) {
        throw new AuthWaitError('AUTH_REQUEST_EXPIRED', 'Authentication request expired. Run `happier auth request --json` again.');
      }
      const opened = openTerminalProvisioningResponse({
        payload: decodeBase64(responseB64),
        terminalSecretKey,
        terminalPublicKey: publicKeyBytes,
        pairing,
        nowMs: Date.now(),
        supportsTokenOnly: true,
      });
      if (!opened) {
        throw new AuthWaitError('AUTH_PAIRING_V3_REQUIRED', V3_REQUIRED_ERROR);
      }

      signal?.throwIfAborted();
      let machineId: string;
      if (state.managedEnrollment) {
        // The normal server registration atomically validates the retained
        // admission and links this machine. Never persist its Account bearer
        // when the managed row was canceled, replaced or otherwise retired.
        await removeProtectedLocalStateFile(statePath, PENDING_AUTH_STATE_PROTECTION);
        ({ machineId } = await registerAndPersistManagedTerminalEnrollmentCredential({ token, opened,
          runtimeOrigin: acquired.runtime.runtimeOrigin, managedEnrollment: state.managedEnrollment,
          machineDisplayName: state.machineDisplayName, deploymentAppBinding: state.deploymentAppBinding,
          homeRetry,
          assertCurrent: () => signal?.throwIfAborted() }));
      } else {
        const persisted = await persistTerminalEnrollmentCredential({ token, opened });
        machineId = await completeClaimedCredentialHandoff({
          credentials: persisted.credentials, statePath, runtimeOrigin: acquired.runtime.runtimeOrigin, homeRetry,
        });
      }
      if (remoteEnrollment) {
        signal?.throwIfAborted();
        await useServerProfile(state.remoteProfileId!);
        signal?.throwIfAborted();
        await writeJsonStdout({ kind: 'remote_home_enrollment_result', protocolVersion: 1,
          success: true, homeServerIdentityId: state.serverIdentityId, machineId,
          encryptionType: opened.type, pairingAuthentication: 'v3', remoteProfileId: state.remoteProfileId });
        return;
      }
      await writeJsonStdout({
        success: true,
        encryptionType: opened.type,
        pairingAuthentication: 'v3' as const,
        machineId,
      });
      return;
    }

    await waitForPollInterval(pollIntervalMs, signal);
    }
  } finally {
    await acquired.close();
  }
}
