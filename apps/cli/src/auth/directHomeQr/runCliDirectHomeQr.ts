import { randomBytes } from 'node:crypto';

import {
  admitDirectHomeQrV2,
  DirectHomeQrCompletionError,
  startDirectHomeQrLifecycle,
  type DirectHomeQrLifecycleAdapters,
} from '@happier-dev/cli-common/homeEnrollment';
import { deriveHomeQrBindingKeyV2, encodeHomeQrInviteV2Payload, parseHomeQrInviteV2Payload } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { sealTerminalProvisioningV3Payload, sealTerminalProvisioningV3TokenOnlyPayload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import qrcode from 'qrcode-terminal';

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { buildTerminalAuthorityCeilingHttpHeaders } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import { resolveAuthenticatedExactHomeConnectionDescriptorObservation, verifyTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentClient';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readStoredCredentialsForServerId } from '@/persistence';
import {
  adoptServerProfileHomeConnectionDescriptor,
  getActiveServerProfile,
  getServerProfile,
  type ServerProfile,
} from '@/server/serverProfiles';
import { resolveTerminalProvisioningMaterial, type TerminalProvisioningMaterial } from '@/auth/terminalProvisioningMaterial';
import { resolveCliHomeTarget } from '@/server/homeTarget';

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
    let parsed: URL;
    try { parsed = new URL(value.link); } catch { return null; }
    const payload = parsed.protocol === 'happier:' && parsed.pathname === '/pair' && parsed.searchParams.get('v') === '2'
      ? parsed.searchParams.get('payload')
      : null;
    const invite = payload ? parseHomeQrInviteV2Payload(payload, { nowMs }) : null;
    if (!invite
      || (expectedHomeServerIdentityId !== undefined
        && invite.home.homeServerIdentityId !== expectedHomeServerIdentityId)) return null;
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

export async function runCliDirectHomeQr(input: Readonly<{
  profileRef?: string;
  copyLink: boolean;
  signal?: AbortSignal;
  onInvite?: (input: Readonly<{ link: string }>) => void;
}>): Promise<CliDirectHomeQrResult> {
  if (input.signal?.aborted) return { kind: 'cancelled' };
  let profile: ServerProfile;
  try {
    profile = input.profileRef
      ? await getServerProfile(input.profileRef)
      : await getActiveServerProfile();
  } catch {
    return { kind: 'failed', status: 404 };
  }
  const storedDescriptor = profile.homeConnectionDescriptor;
  if (storedDescriptor && profile.homeConnectionDescriptorAuthority !== 'exact') return { kind: 'failed', status: 412 };
  const credentials = await readStoredCredentialsForServerId(profile.id);
  if (!credentials?.token) return { kind: 'failed', status: 401 };

  let target: Awaited<ReturnType<typeof resolveCliHomeTarget>>;
  try {
    target = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: profile.id });
  } catch {
    return { kind: 'failed', status: 412 };
  }
  const acquired = await acquireTerminalAuthEnrollmentRuntime(storedDescriptor ?? target, undefined, input.signal);
  if (!acquired.ok) return input.signal?.aborted
    ? { kind: 'cancelled' }
    : { kind: 'failed', status: 503 };
  const origin = normalizeOrigin(acquired.runtime.runtimeOrigin);
  let observed: Awaited<ReturnType<typeof observeServerFeaturesSnapshot>>;
  try {
    observed = await observeServerFeaturesSnapshot({ serverUrl: origin, token: credentials.token, signal: input.signal });
  } catch (error) {
    await acquired.close().catch(() => undefined);
    if (input.signal?.aborted) return { kind: 'cancelled' };
    throw error;
  }
  if (observed.status === 'unsupported') {
    await acquired.close().catch(() => undefined);
    return { kind: 'update_required' };
  }
  if (observed.status === 'error') {
    await acquired.close().catch(() => undefined);
    return { kind: 'failed', status: 503 };
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
    return { kind: 'failed', status: 412 };
  }
  if (exactObservation.kind === 'unavailable') {
    await acquired.close().catch(() => undefined);
    return { kind: 'update_required' };
  }
  const observedDescriptor = exactObservation.descriptor;
  // Admission owns whether this flow may mutate state at all. The lifecycle
  // repeats the same canonical check immediately before starting the pairing.
  if (admitDirectHomeQrV2(observed.features).kind !== 'admitted') {
    await acquired.close().catch(() => undefined);
    return { kind: 'update_required' };
  }
  let descriptor: NonNullable<typeof storedDescriptor>;
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
  const authHeaders = () => ({
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    ...buildTerminalAuthorityCeilingHttpHeaders({ token: credentials.token, serverHttpBaseUrl: origin }),
    Authorization: `Bearer ${credentials.token}`,
  });
  const adapters: DirectHomeQrLifecycleAdapters = {
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    now: Date.now,
    start: async ({ signal, ...body }) => {
      const response = await fetch(`${origin}/v1/auth/pairing/start`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
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
        response = await fetch(`${origin}/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`, {
          headers: authHeaders(),
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch {
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
        const response = await fetch(`${origin}/v1/auth/pairing/consume`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
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
      } catch {
        return { ok: false };
      }
    },
    complete: async ({ context, requesterPublicKey, signal }) => {
      let material: TerminalProvisioningMaterial;
      try {
        material = resolveTerminalProvisioningMaterial(credentials);
      } catch {
        throw new DirectHomeQrCompletionError('invalid');
      }
      const common = {
        terminalEphemeralPublicKey: requesterPublicKey,
        pairingSecret: deriveHomeQrBindingKeyV2(context.qrSecret),
        createdAtMs: context.issuedAtMs,
        expiresAtMs: context.expiresAtMs,
        randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
      };
      let sealed: Uint8Array;
      let responseKind: 'tokenOnly' | 'dataKey';
      if (material.kind === 'tokenOnly') {
        responseKind = 'tokenOnly';
        sealed = sealTerminalProvisioningV3TokenOnlyPayload(common);
      } else {
        responseKind = 'dataKey';
        sealed = sealTerminalProvisioningV3Payload({ ...common, contentPrivateKey: material.contentPrivateKey });
      }
      let response: Response;
      try {
        response = await fetch(`${origin}/v1/auth/account/response`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pairId: context.pairId,
            publicKey: Buffer.from(requesterPublicKey).toString('base64'),
            response: Buffer.from(sealed).toString('base64'),
            homeServerIdentityId: context.homeServerIdentityId,
            responseKind,
          }),
          signal,
        });
      } catch {
        throw new DirectHomeQrCompletionError('retryable');
      }
      if (response.ok) return 'completed';
      if (response.status === 409) {
        const payload = await readJson(response);
        if (isRecord(payload) && payload.error === 'already_completed') return 'already_completed';
      }
      throw new DirectHomeQrCompletionError(response.status === 408 || response.status === 429 || response.status >= 500 ? 'retryable' : 'failed');
    },
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
    sleep,
    close: acquired.close,
  };

  const started = await startDirectHomeQrLifecycle({
    features: observed.features,
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
  return await started.completion;
}
