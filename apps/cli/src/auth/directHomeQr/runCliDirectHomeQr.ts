import { randomBytes } from 'node:crypto';

import {
  admitDirectHomeQrV2,
  AccountCompletionError,
  completeHomeQrRequest,
  DirectHomeQrCompletionError,
  inspectHomeQrPairLink,
  runDirectHomeQrCompletion,
  startDirectHomeQrLifecycle,
  type DirectHomeQrLifecycleAdapters,
} from '@happier-dev/cli-common/homeEnrollment';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveHomeQrRendezvousVerifierV2, encodeHomeQrInviteV2Payload, type HomeQrInviteV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import type { TerminalProvisioningV2Response } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import qrcode from 'qrcode-terminal';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import { resolveAuthenticatedExactHomeConnectionDescriptorObservation, verifyTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentClient';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { AccountEncryptionCurrentnessUnavailableError, fetchAccountEncryptionCurrentnessFromServer } from '@/api/client/connectedServiceCredentialApi';
import { readHttpStatus } from '@/api/client/httpStatusError';
import { readStoredCredentialsForServerId } from '@/persistence';
import { TerminalProvisioningMaterialInvalidError } from '@/auth/terminalAuthApproval';
import { validateStoredAuthTokenAgainstServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import {
  adoptServerProfileHomeConnectionDescriptor,
  getActiveServerProfile,
  getServerProfile,
  type ServerProfile,
} from '@/server/serverProfiles';
import { resolveTerminalProvisioningMaterial } from '@/auth/terminalProvisioningMaterial';
import { configuration } from '@/configuration';
import { readSavedCliHomeProfile, resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';

export type CliDirectHomeQrResult =
  | Readonly<{ kind: 'completed'; requestedDeviceLabel: string | null }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'expired' }>
  | Readonly<{ kind: 'invalid_request' }>
  | Readonly<{ kind: 'update_required' }>
  | Readonly<{ kind: 'failed'; status: number }>;

export type CliDirectHomeQrTaskStreamEvent =
  | Readonly<{ v: 1; kind: 'home_pair_device.invite'; link: string }>
  | Readonly<{ v: 1; kind: 'home_pair_device.result'; result: CliDirectHomeQrResult }>;

function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/u, '');
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function renderTerminalQr(link: string): string | null {
  let output: string | null = null;
  try {
    qrcode.generate(link, { small: true }, (value) => { output = value; });
  } catch {
    return null;
  }
  return output;
}

export function presentCliDirectHomeQrInvite(input: Readonly<{ link: string; copyLink: boolean }>): void {
  const qrOutput = input.copyLink ? null : renderTerminalQr(input.link);
  if (input.copyLink || qrOutput === null) {
    console.log(input.link);
    return;
  }
  console.log('Scan this QR code with the phone or browser you want to add:');
  console.log(qrOutput);
}

export function encodeCliDirectHomeQrTaskStreamEvent(event: CliDirectHomeQrTaskStreamEvent): string {
  return JSON.stringify(event);
}

export function parseCliDirectHomeQrTaskStreamEvent(
  line: string,
  nowMs = Date.now(),
  expectedHomeServerIdentityId?: string,
): CliDirectHomeQrTaskStreamEvent | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!isRecord(value) || value.v !== 1 || typeof value.kind !== 'string') return null;
  if (value.kind === 'home_pair_device.invite') {
    if (!exactKeys(value, ['v', 'kind', 'link']) || typeof value.link !== 'string') return null;
    const result = inspectHomeQrPairLink(value.link, (protocol) => protocol === 'happier:', nowMs);
    if (result?.kind !== 'valid'
      || (expectedHomeServerIdentityId !== undefined
        && result.invite.home.homeServerIdentityId !== expectedHomeServerIdentityId)) return null;
    return { v: 1, kind: 'home_pair_device.invite', link: value.link };
  }
  if (value.kind !== 'home_pair_device.result' || !exactKeys(value, ['v', 'kind', 'result']) || !isRecord(value.result)) return null;
  const result = value.result;
  if (result.kind === 'completed'
    && exactKeys(result, ['kind', 'requestedDeviceLabel'])
    && (result.requestedDeviceLabel === null || typeof result.requestedDeviceLabel === 'string')) {
    return { v: 1, kind: 'home_pair_device.result', result: { kind: 'completed', requestedDeviceLabel: result.requestedDeviceLabel } };
  }
  if ((result.kind === 'cancelled' || result.kind === 'expired' || result.kind === 'invalid_request' || result.kind === 'update_required')
    && exactKeys(result, ['kind'])) {
    return { v: 1, kind: 'home_pair_device.result', result: { kind: result.kind } };
  }
  if (result.kind === 'failed' && exactKeys(result, ['kind', 'status']) && Number.isInteger(result.status) && Number(result.status) >= 0) {
    return { v: 1, kind: 'home_pair_device.result', result: { kind: 'failed', status: Number(result.status) } };
  }
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function acquireCliHomeQrTarget(profile: ServerProfile | null, signal?: AbortSignal) {
  if (signal?.aborted) return { kind: 'cancelled' as const };
  const storedDescriptor = profile?.homeConnectionDescriptor;
  if (storedDescriptor && profile?.homeConnectionDescriptorAuthority !== 'exact') return { kind: 'failed' as const, status: 412 };
  const credentials = await readStoredCredentialsForServerId(profile?.id ?? configuration.activeServerId);
  if (!credentials?.token) return { kind: 'failed' as const, status: 401 };

  let target: Awaited<ReturnType<typeof resolveCliHomeTarget>>;
  try {
    target = profile
      ? await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: profile.id })
      : await resolveCurrentCliHomeTarget();
  } catch {
    return { kind: 'failed' as const, status: 412 };
  }
  const acquired = await acquireTerminalAuthEnrollmentRuntime(storedDescriptor ?? target, undefined, signal);
  if (!acquired.ok) return signal?.aborted
    ? { kind: 'cancelled' as const }
    : { kind: 'failed' as const, status: 503 };
  const origin = normalizeOrigin(acquired.runtime.runtimeOrigin);
  let observed: Awaited<ReturnType<typeof observeServerFeaturesSnapshot>>;
  try {
    observed = await observeServerFeaturesSnapshot({ serverUrl: origin, token: credentials.token, signal });
  } catch (error) {
    await acquired.close().catch(() => undefined);
    if (signal?.aborted) return { kind: 'cancelled' as const };
    throw error;
  }
  if (observed.status === 'unsupported') {
    await acquired.close().catch(() => undefined);
    return { kind: 'update_required' as const };
  }
  if (observed.status === 'error') {
    await acquired.close().catch(() => undefined);
    return { kind: 'failed' as const, status: 503 };
  }
  let exactObservation;
  try {
    // URL-only profiles use the same exact-origin verification as terminal
    // login. Only the authenticated Home projection can establish the descriptor;
    // the public predecessor fallback remains advisory and cannot start pairing.
    const expectedHomeServerIdentityId = storedDescriptor?.homeServerIdentityId
      ?? verifyTerminalAuthEnrollmentRuntime({ target, runtime: acquired.runtime, snapshot: observed }).homeServerIdentityId;
    exactObservation = resolveAuthenticatedExactHomeConnectionDescriptorObservation({
      snapshot: observed,
      expectedHomeServerIdentityId,
    });
  } catch {
    await acquired.close().catch(() => undefined);
    return { kind: 'failed' as const, status: 412 };
  }
  if (exactObservation.kind === 'unavailable') {
    await acquired.close().catch(() => undefined);
    return { kind: 'update_required' as const };
  }
  const observedDescriptor = exactObservation.descriptor;
  // Admission owns whether this flow may mutate state at all. The lifecycle
  // repeats the same canonical check immediately before starting the pairing.
  if (admitDirectHomeQrV2(observed.features).kind !== 'admitted') {
    await acquired.close().catch(() => undefined);
    return { kind: 'update_required' as const };
  }
  return { kind: 'ready' as const, credentials, acquired, origin, observedDescriptor, features: observed.features };
}

type CliHomeQrTarget = Extract<Awaited<ReturnType<typeof acquireCliHomeQrTarget>>, { kind: 'ready' }>;
type CliHomeQrStartInput = Parameters<DirectHomeQrLifecycleAdapters['start']>[0]
  | Readonly<{ direction: 'requester_displays'; secretHash: string; pairId: string; expiresAtMs: number; signal: AbortSignal }>;

function cliHomeQrRequest({ credentials, origin }: CliHomeQrTarget) {
  return (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(buildCurrentAccountStoredContentCompatibilityHttpHeaders())) {
      headers.set(key, value);
    }
    headers.set('Authorization', `Bearer ${credentials.token}`);
    return fetchWithCredentialRedirectRefusal(`${origin}${path}`, { ...init, headers });
  };
}

async function readCliHomeQrMaterial(
  runtime: CliHomeQrTarget,
  request: ReturnType<typeof cliHomeQrRequest>,
  signal?: AbortSignal,
): Promise<TerminalProvisioningV2Response> {
  let currentness: Awaited<ReturnType<typeof fetchAccountEncryptionCurrentnessFromServer>>;
  try {
    currentness = await fetchAccountEncryptionCurrentnessFromServer({
      credentials: runtime.credentials, token: runtime.credentials.token,
      serverBaseUrl: runtime.origin, signal, allowCredentialRecovery: false,
      request: async () => {
        const response = await request('/v1/account/encryption/currentness', { signal });
        return { status: response.status, data: await readJson(response) };
      },
    });
  } catch (error) {
    if (error instanceof CredentialRequestRedirectError) throw error;
    signal?.throwIfAborted();
    const status = readHttpStatus(error) ?? (error instanceof AccountEncryptionCurrentnessUnavailableError ? readHttpStatus(error.cause) : null);
    const retryable = status !== null ? status === 408 || status === 429 || status >= 500
      : error instanceof AccountEncryptionCurrentnessUnavailableError && error.cause !== undefined;
    throw new DirectHomeQrCompletionError(retryable ? 'retryable' : 'invalid');
  }
  try {
    const material = resolveTerminalProvisioningMaterial(runtime.credentials, currentness);
    return material.kind === 'tokenOnly' ? { type: 'tokenOnly' } : { type: 'dataKey', key: material.contentPrivateKey };
  } catch {
    throw new TerminalProvisioningMaterialInvalidError();
  }
}

function createCliHomeQrAdapters(runtime: CliHomeQrTarget):
  Pick<DirectHomeQrLifecycleAdapters, 'now' | 'poll' | 'consume' | 'complete' | 'sleep'>
  & Readonly<{ start(input: CliHomeQrStartInput): ReturnType<DirectHomeQrLifecycleAdapters['start']> }> {
  const request = cliHomeQrRequest(runtime);
  return {
    now: Date.now,
    start: async ({ signal, ...body }) => {
      const response = await request('/v1/auth/pairing/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) return { ok: false, status: response.status };
      const payload = await readJson(response);
      if (!isRecord(payload) || !exactKeys(payload, ['pairId', 'expiresAt']) || typeof payload.pairId !== 'string' || typeof payload.expiresAt !== 'string') {
        return { ok: false, status: 502 };
      }
      return { ok: true, pairId: payload.pairId, expiresAt: payload.expiresAt };
    },
    poll: async ({ pairId, signal, timeoutMs }) => {
      let response: Response;
      try {
        response = await request(`/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error) {
        if (error instanceof CredentialRequestRedirectError) throw error;
        return { ok: false, reason: 'transient', status: 0 };
      }
      if (response.status === 404) return { ok: false, reason: 'not_found', status: 404 };
      if (!response.ok) {
        return {
          ok: false,
          reason: response.status === 408 || response.status === 429 || response.status >= 500 ? 'transient' : 'invalid',
          status: response.status,
        };
      }
      return { ok: true, status: await readJson(response) };
    },
    consume: async ({ pairId, intent, signal, timeoutMs }) => {
      try {
        const response = await request('/v1/auth/pairing/consume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairId, intent }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (response.ok) return { ok: true, outcome: 'cancelled' };
        if (response.status === 409) {
          const payload = await readJson(response);
          if (isRecord(payload) && exactKeys(payload, ['error']) && payload.error === 'already_decided') {
            return { ok: true, outcome: 'completion_won' };
          }
        }
        return { ok: false };
      } catch (error) {
        if (error instanceof CredentialRequestRedirectError) throw error;
        return { ok: false };
      }
    },
    complete: async ({ context, requesterPublicKey, signal }) => {
      try {
        return await completeHomeQrRequest({
          context, requesterPublicKey,
          target: { homeServerIdentityId: runtime.observedDescriptor.homeServerIdentityId, request },
          material: await readCliHomeQrMaterial(runtime, request, signal),
          randomBytes,
          signal,
        });
      } catch (error) {
        if (error instanceof AccountCompletionError) {
          throw new DirectHomeQrCompletionError(error.retryable ? 'retryable' : 'failed');
        }
        if (error instanceof TerminalProvisioningMaterialInvalidError) {
          throw new DirectHomeQrCompletionError('invalid', { cause: error });
        }
        throw error;
      }
    },
    sleep,
  };
}

export class CliHomeQrApprovalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CliHomeQrApprovalError';
  }
}

export async function approveCliDirectHomeQr(input: Readonly<{
  invite: Extract<HomeQrInviteV2, { direction: 'requester_displays' }>;
  confirm: (facts: Readonly<{ deviceLabel: string | null; homeUrl: string; accountLabel: string; accountId: string }>) => Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<void> {
  const { invite, signal } = input;
  const profile = await readSavedCliHomeProfile(configuration.activeServerId);
  const runtime = await acquireCliHomeQrTarget(profile, signal);
  if (runtime.kind !== 'ready') {
    signal?.throwIfAborted();
    switch (runtime.kind) {
      case 'update_required': throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_UPDATE_REQUIRED', 'Update the selected Home and CLI to use device-code pairing.');
      case 'cancelled': throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_CANCELLED', 'Device-code approval was cancelled.');
      case 'failed': throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_HOME_UNAVAILABLE', 'Unable to verify the selected signed-in Home.');
    }
  }
  try {
    if (runtime.observedDescriptor.homeServerIdentityId !== invite.home.homeServerIdentityId) {
      throw new CliHomeQrApprovalError('HOME_AUTHORITY_MISMATCH', 'The device code belongs to a different Home.');
    }
    const account = await validateStoredAuthTokenAgainstServer({
      token: runtime.credentials.token, baseUrl: runtime.origin, signal,
    });
    if (account.state !== 'valid') {
      throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_ACCOUNT_UNAVAILABLE', 'Unable to verify the selected Account.');
    }
    const confirmed = await input.confirm({
      deviceLabel: invite.requestedDeviceLabel ?? null,
      homeUrl: runtime.observedDescriptor.canonicalServerUrl,
      accountId: account.accountId,
      accountLabel: account.accountLabel ?? account.accountId,
    });
    if (!confirmed) throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_DECLINED', 'Device-code approval declined.');
    signal?.throwIfAborted();

    const adapters = createCliHomeQrAdapters(runtime);
    const qrSecret = decodeBase64(invite.qrSecretBase64Url, 'base64url');
    const started = await adapters.start({
      direction: invite.direction, pairId: invite.pairId, expiresAtMs: invite.expiresAtMs,
      secretHash: encodeBase64(deriveHomeQrRendezvousVerifierV2(qrSecret), 'base64url'),
      signal: signal ?? new AbortController().signal,
    });
    if (!started.ok) {
      if (started.status === 409) {
        throw new CliHomeQrApprovalError('pair_id_conflict', 'The Home could not bind this code to the selected Account. Request a new device code.');
      }
      throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_START_FAILED', `The Home did not accept the device code (HTTP ${started.status}).`);
    }
    if (started.pairId !== invite.pairId || Date.parse(started.expiresAt) !== invite.expiresAtMs) {
      throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_INVALID_INVITE', 'The Home did not acknowledge the exact device code.');
    }
    const outcome = await runDirectHomeQrCompletion({
      direction: invite.direction,
      pairId: invite.pairId,
      homeServerIdentityId: invite.home.homeServerIdentityId,
      qrSecret,
      issuedAtMs: invite.issuedAtMs,
      expiresAtMs: invite.expiresAtMs,
      expectedRequesterPublicKey: decodeBase64(invite.requesterPublicKeyBase64Url, 'base64url'),
      adapters: { ...adapters, close: async () => {} },
      signal,
    }).completion;
    if (outcome.kind !== 'completed' && outcome.kind !== 'already_completed') {
      throw new CliHomeQrApprovalError('HOME_QR_APPROVAL_INCOMPLETE', `Device-code pairing did not complete (${outcome.kind}).`);
    }
  } finally {
    await runtime.acquired.close().catch(() => undefined);
  }
}

export async function runCliDirectHomeQr(input: Readonly<{
  profileRef?: string;
  copyLink: boolean;
  signal?: AbortSignal;
  onInvite?: (input: Readonly<{ link: string }>) => void;
}>): Promise<CliDirectHomeQrResult> {
  if (input.signal?.aborted) return { kind: 'cancelled' };
  let profile: ServerProfile;
  try {
    profile = input.profileRef ? await getServerProfile(input.profileRef) : await getActiveServerProfile();
  } catch {
    return { kind: 'failed', status: 404 };
  }
  const runtime = await acquireCliHomeQrTarget(profile, input.signal);
  if (runtime.kind !== 'ready') return runtime;
  const { acquired, features, observedDescriptor } = runtime;
  let descriptor: typeof observedDescriptor;
  try {
    const reconciled = await adoptServerProfileHomeConnectionDescriptor({
      descriptor: observedDescriptor,
      expectedProfileId: profile.id,
      observation: 'exact',
    });
    const currentDescriptor = reconciled.profile.homeConnectionDescriptor;
    if (!currentDescriptor || reconciled.profile.homeConnectionDescriptorAuthority !== 'exact') {
      await acquired.close().catch(() => undefined);
      return { kind: 'failed', status: 412 };
    }
    descriptor = currentDescriptor;
  } catch {
    await acquired.close().catch(() => undefined);
    return { kind: 'failed', status: 412 };
  }

  let qrOutput: string | null = null;
  const adapters: DirectHomeQrLifecycleAdapters = {
    ...createCliHomeQrAdapters(runtime),
    randomBytes,
    buildRenderableInvite: (invite) => {
      let link: string;
      try {
        link = `happier:///pair?v=2&payload=${encodeURIComponent(encodeHomeQrInviteV2Payload(invite))}`;
      } catch {
        return { ok: false, reason: 'invalid_invite' };
      }
      qrOutput = renderTerminalQr(link);
      return qrOutput === null
        ? { ok: false, reason: 'qr_unavailable', link }
        : { ok: true, link, invite };
    },
    close: acquired.close,
  };

  const started = await startDirectHomeQrLifecycle({
    features,
    descriptor,
    adapters,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (started.kind === 'update_required') return started;
  if (started.kind === 'cancelled') return started;
  if (started.kind === 'failed') return { kind: 'failed', status: started.status };
  if (input.onInvite) {
    input.onInvite({ link: started.link });
  } else {
    presentCliDirectHomeQrInvite({ link: started.link, copyLink: input.copyLink || !started.qrAvailable || qrOutput === null });
  }
  try {
    return await started.completion;
  } catch (error) {
    if (error instanceof TerminalProvisioningMaterialInvalidError) return { kind: 'invalid_request' };
    throw error;
  }
}
