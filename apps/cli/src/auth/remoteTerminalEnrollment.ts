import type { DeploymentAppMachineBindingV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { createHash, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { MachineEnrollmentCorrelationV1Schema, type MachineEnrollmentCorrelationV1, type ManagedEnrollmentMachineMetadataV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import { assertOrganizationPolicyEndpointAllowed } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';

import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import {
  createTerminalPairingAuthentication,
  applyTerminalAuthRequestExpiry,
  openTerminalProvisioningResponse,
} from '@/auth/terminalProvisioningResponse';
import {
  claimTerminalAuthRequest,
  createTerminalAuthRequest,
  readTerminalAuthRequestStatus,
  resolveAuthenticatedExactHomeConnectionDescriptorObservation,
  verifyTerminalAuthEnrollmentRuntime,
} from '@/auth/terminalAuthEnrollmentClient';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import {
  persistTerminalEnrollmentCredential,
  registerAndPersistManagedTerminalEnrollmentCredential,
  registerTerminalEnrollmentMachine,
} from '@/auth/persistTerminalEnrollmentCredential';
import {
  fetchServerFeaturesSnapshot,
  observeServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import { retryHomeOperation, REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS } from '@/api/client/retryHomeOperation';
import { configuration } from '@/configuration';
import { adoptServerProfileHomeConnectionDescriptor, readExactServerProfileForHomeIdentity, setServerProfileEndpointsById, upsertServerProfileByUrl } from '@/server/serverProfiles';
import { runWithServerProfileSelection } from '@/server/serverSelection';

const MAX_PROVISIONING_RESPONSE_B64_CHARS = 4096;

function enrollmentError(code: 'AUTH_ENROLL_REMOTE_CANCELLED' | 'AUTH_ENROLL_REMOTE_TIMEOUT'
  | 'AUTH_ENROLL_REMOTE_REQUEST_EXPIRED' | 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE' | 'AUTH_ENROLL_REMOTE_IDENTITY_MISMATCH'
  | 'AUTH_ENROLL_REMOTE_INVALID_RESPONSE' | 'AUTH_ENROLL_REMOTE_PAIRING_REQUIRED', message: string): Error & { code: typeof code } {
  return Object.assign(new Error(message), { code });
}

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
  remoteProfileId: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function remainingMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

function throwIfStopped(signal: AbortSignal | undefined, deadlineMs: number): void {
  if (signal?.aborted) {
    throw enrollmentError('AUTH_ENROLL_REMOTE_CANCELLED', 'Remote Home enrollment was cancelled.');
  }
  if (Date.now() >= deadlineMs) {
    throw enrollmentError('AUTH_ENROLL_REMOTE_TIMEOUT', 'Remote Home enrollment timed out.');
  }
}

async function delayWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, ms);
    const onAbort = () => finish(enrollmentError('AUTH_ENROLL_REMOTE_CANCELLED', 'Remote Home enrollment was cancelled.'));
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

async function selectRemoteUrlEnrollmentProfile(target: ResolvedHomeTarget, homeServerIdentityId: string, snapshot: CliServerFeaturesSnapshot): Promise<string> {
  const observation = resolveAuthenticatedExactHomeConnectionDescriptorObservation({ snapshot, expectedHomeServerIdentityId: homeServerIdentityId });
  if (observation.kind === 'available') {
    const { profile, outcome } = await adoptServerProfileHomeConnectionDescriptor({
      descriptor: observation.descriptor, suggestedName: 'custom', webappUrl: target.webappUrl, observation: 'exact',
    });
    if (outcome !== 'stale') {
      await setServerProfileEndpointsById({ id: profile.id, serverUrl: profile.serverUrl,
        localServerUrl: target.applicationUrl, webappUrl: profile.webappUrl });
    }
    return profile.id;
  }
  // Without a published descriptor, authenticated identity can select an existing scope but cannot replace its routes.
  if (snapshot.status === 'ready' && snapshot.provenance === 'authenticated') {
    const retained = await readExactServerProfileForHomeIdentity(homeServerIdentityId);
    if (retained) return retained.id;
  }
  return (await upsertServerProfileByUrl({ name: 'custom', serverUrl: target.canonicalAuthUrl,
    localServerUrl: target.applicationUrl, webappUrl: target.webappUrl })).id;
}

/**
 * SSH automation's canonical terminal enrollment owner. Ephemeral key, claim,
 * and v3 pairing secrets never leave this process. Only the short-lived v3
 * approval context is emitted, and only the final Home credential is persisted.
 */
export async function runRemoteTerminalEnrollment(params: Readonly<{
  target: ResolvedHomeTarget;
  managedEnrollment?: MachineEnrollmentCorrelationV1;
  machineDisplayName?: string;
  initialMachineMetadata?: ManagedEnrollmentMachineMetadataV1;
  deploymentAppBinding?: DeploymentAppMachineBindingV1;
  signal?: AbortSignal;
  timeoutMs: number;
  pollIntervalMs?: number;
  onPairingRequest(request: RemoteTerminalEnrollmentPairingRequest): Promise<void> | void;
}>): Promise<RemoteTerminalEnrollmentResult> {
  const deadlineMs = Date.now() + Math.max(1, Math.floor(params.timeoutMs));
  const pollIntervalMs = Math.max(1, Math.floor(params.pollIntervalMs ?? REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS));
  const homeRetry = { deadlineMs, pollIntervalMs, signal: params.signal };
  throwIfStopped(params.signal, deadlineMs);
  const managedEnrollment = params.managedEnrollment === undefined ? undefined
    : MachineEnrollmentCorrelationV1Schema.parse(params.managedEnrollment);
  if (managedEnrollment && params.target.homeServerIdentityId !== managedEnrollment.homeId) {
    throw enrollmentError('AUTH_ENROLL_REMOTE_IDENTITY_MISMATCH', 'Managed enrollment does not match the selected Home.');
  }
  if (!params.target.descriptor) {
    assertOrganizationPolicyEndpointAllowed(configuration.organizationPolicy, 'home', params.target.canonicalAuthUrl);
  }

  const acquired = await acquireTerminalAuthEnrollmentRuntime(
    params.target.descriptor ?? params.target,
    params.target.preferredTransport,
    params.signal,
  );
  if (!acquired.ok) {
    throw Object.assign(enrollmentError('AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE', 'Unable to acquire the selected Home enrollment carrier.'),
      { cause: acquired.error, carrierFailure: acquired.carrierFailure });
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
      phase: 'first_contact',
    });

    const secretKey = new Uint8Array(randomBytes(32));
    const keypair = tweetnacl.box.keyPair.fromSecretKey(secretKey);
    const claimSecret = new Uint8Array(randomBytes(32));
    const claimSecretB64Url = Buffer.from(claimSecret).toString('base64url');
    const claimSecretHash = createHash('sha256').update(Buffer.from(claimSecret)).digest('base64url');
    let pairing = createTerminalPairingAuthentication({
      nowMs: Date.now(),
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
    });
    const publicKey = encodeBase64(keypair.publicKey);

    const response = await createTerminalAuthRequest({
      runtime: acquired.runtime,
      publicKey,
      supportsV2: true,
      claimSecretHash,
      headers: buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      timeoutMs: remainingMs(deadlineMs),
      signal: params.signal,
    });
    pairing = applyTerminalAuthRequestExpiry(pairing, response);
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
        throw enrollmentError('AUTH_ENROLL_REMOTE_REQUEST_EXPIRED', 'Remote Home enrollment request expired.');
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
        throw enrollmentError('AUTH_ENROLL_REMOTE_IDENTITY_MISMATCH', 'Remote Home enrollment response identity does not match the selected Home.');
      }
      const token = typeof claimData.token === 'string' ? claimData.token : '';
      const responseB64 = typeof claimData.response === 'string' ? claimData.response : '';
      if (!token || !responseB64 || responseB64.length > MAX_PROVISIONING_RESPONSE_B64_CHARS) {
        throw enrollmentError('AUTH_ENROLL_REMOTE_INVALID_RESPONSE', 'Remote Home enrollment returned an invalid provisioning response.');
      }
      const authenticatedSnapshot = await retryHomeOperation(homeRetry, async () => {
        throwIfStopped(params.signal, deadlineMs);
        const authenticatedSnapshot = await observeServerFeaturesSnapshot({
          serverUrl: acquired.runtime.runtimeOrigin,
          token,
          timeoutMs: remainingMs(deadlineMs),
          signal: params.signal,
        });
        const observed = verifyTerminalAuthEnrollmentRuntime({
          target: params.target,
          runtime: acquired.runtime,
          snapshot: authenticatedSnapshot,
          phase: 'post_claim',
        });
        if (observed.homeServerIdentityId !== claimedIdentity) {
          throw enrollmentError('AUTH_ENROLL_REMOTE_IDENTITY_MISMATCH', 'Authenticated Home identity changed during remote enrollment.');
        }
        return authenticatedSnapshot;
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
        throw enrollmentError('AUTH_ENROLL_REMOTE_PAIRING_REQUIRED', 'Authenticated terminal pairing v3 is required.');
      }
      throwIfStopped(params.signal, deadlineMs);
      const complete = async () => {
        throwIfStopped(params.signal, deadlineMs);
        if (managedEnrollment) {
          return await registerAndPersistManagedTerminalEnrollmentCredential({ token, opened,
            runtimeOrigin: acquired.runtime.runtimeOrigin, managedEnrollment,
            machineDisplayName: params.machineDisplayName, initialMachineMetadata: params.initialMachineMetadata, deploymentAppBinding: params.deploymentAppBinding,
            homeRetry,
            assertCurrent: () => throwIfStopped(params.signal, deadlineMs) });
        }
        const persisted = await persistTerminalEnrollmentCredential({ token, opened });
        const machineId = await registerTerminalEnrollmentMachine(persisted.credentials, acquired.runtime.runtimeOrigin, undefined, homeRetry);
        throwIfStopped(params.signal, deadlineMs);
        return { machineId, encryptionType: persisted.encryptionType };
      };
      const remoteProfileId = params.target.descriptor ? configuration.activeServerId
        : await selectRemoteUrlEnrollmentProfile(params.target, claimedIdentity, authenticatedSnapshot);
      const completion = params.target.descriptor ? await complete() : await runWithServerProfileSelection(remoteProfileId, complete);
      return {
        success: true,
        homeServerIdentityId: verified.homeServerIdentityId,
        ...completion,
        pairingAuthentication: 'v3',
        remoteProfileId,
      };
    }
  } finally {
    await acquired.close();
  }
}
