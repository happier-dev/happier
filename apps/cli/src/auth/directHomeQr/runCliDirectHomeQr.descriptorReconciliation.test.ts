import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  computeHomeQrBindingProofV2,
  decodeBase64,
  encodeBase64,
  parseHomeQrInviteV2Payload,
  type HomeConnectionDescriptorV1,
  type HomeQrInviteV2,
} from '@happier-dev/protocol';

import { reloadConfiguration } from '@/configuration';
import * as profiles from '@/server/serverProfiles';
import { writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const featureBoundary = vi.hoisted(() => ({
  read: vi.fn(),
}));

const carrierBoundary = vi.hoisted(() => ({
  acquire: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  observeServerFeaturesSnapshot: featureBoundary.read,
}));

vi.mock('@/auth/terminalAuthEnrollmentRuntime', () => ({
  acquireTerminalAuthEnrollmentRuntime: carrierBoundary.acquire,
}));

function descriptor(input: Readonly<{
  revision: number;
  identity?: string;
  origin?: string;
}>): HomeConnectionDescriptorV1 {
  const origin = input.origin ?? 'https://qr-home.example.test';
  return {
    v: 1,
    homeServerIdentityId: input.identity ?? 'srv_qr_home',
    canonicalServerUrl: origin,
    revision: input.revision,
    endpoints: [{ kind: 'https', url: origin }],
  };
}

describe('CLI direct Home QR descriptor reconciliation', () => {
  let runCliDirectHomeQr: typeof import('./runCliDirectHomeQr').runCliDirectHomeQr;

  beforeAll(async () => {
    ({ runCliDirectHomeQr } = await import('./runCliDirectHomeQr'));
  });

  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const);
    featureBoundary.read.mockReset();
    carrierBoundary.acquire.mockReset();
    carrierBoundary.close.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function runCase(
    stored: HomeConnectionDescriptorV1,
    observed: HomeConnectionDescriptorV1,
    boundQrV2Enabled = true,
    options: Readonly<{
      abortDuringAcquire?: boolean;
      abortAfterFeatureRead?: boolean;
      observationProvenance?: 'authenticated' | 'public';
      /** Let the requester claim the invite and drive the pairing through completion. */
      completePairing?: boolean;
      transientModeFailure?: boolean;
      redirectPath?: string;
      requests?: string[];
      redirectedRequests?: Array<{ authorizationPresent: boolean; bodyPresent: boolean }>;
    }> = {},
  ) {
    return await withTempDir('happier-cli-direct-qr-descriptor-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      // Configuration is a live binding re-derived from HAPPIER_HOME_DIR; the module graph stays warm.
      reloadConfiguration();

      const profile = await profiles.addServerProfile({
        name: 'qr-home',
        serverUrl: stored.canonicalServerUrl,
        webappUrl: stored.canonicalServerUrl,
        use: true,
      });
      await profiles.adoptServerProfileHomeConnectionDescriptor({
        descriptor: stored,
        expectedProfileId: profile.id,
        observation: 'exact',
      });
      await writeCredentialsTokenOnlyForServerId(profile.id, { token: 'home-token' });
      const controller = new AbortController();
      if (options.abortDuringAcquire) {
        carrierBoundary.acquire.mockImplementation(async () => {
          controller.abort(new DOMException('cancelled', 'AbortError'));
          return { ok: false, reason: 'unavailable', error: new Error('carrier cancelled') };
        });
      } else {
        carrierBoundary.acquire.mockResolvedValue({
          ok: true,
          runtime: {
            runtimeOrigin: stored.canonicalServerUrl,
            carrier: 'https',
            authenticatedCredentialDestination: {
              kind: 'https',
              applicationUrl: stored.canonicalServerUrl,
            },
          },
          close: carrierBoundary.close,
        });
      }
      featureBoundary.read.mockResolvedValue({
        status: 'ready',
        provenance: options.observationProvenance ?? 'authenticated',
        features: {
          features: { auth: { pairing: { boundQrV2: { enabled: boundQrV2Enabled } } } },
          capabilities: {
            serverIdentity: { serverIdentityId: stored.homeServerIdentityId },
          },
          homeConnectionDescriptor: observed,
        },
      });
      if (options.abortAfterFeatureRead) {
        featureBoundary.read.mockImplementationOnce(async () => {
          controller.abort(new DOMException('cancelled', 'AbortError'));
          return {
            status: 'ready',
            provenance: options.observationProvenance ?? 'authenticated',
            features: {
              features: { auth: { pairing: { boundQrV2: { enabled: boundQrV2Enabled } } } },
              capabilities: {
                serverIdentity: { serverIdentityId: stored.homeServerIdentityId },
              },
              homeConnectionDescriptor: observed,
            },
          };
        });
      }

      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const requesterPublicKey = new Uint8Array(32).fill(8);
      let resolveEmittedInvite!: (invite: HomeQrInviteV2) => void;
      const emittedInvite = new Promise<HomeQrInviteV2>((resolve) => { resolveEmittedInvite = resolve; });
      const accountResponseBodies: unknown[] = [];
      let modeFailurePending = options.transientModeFailure === true;
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        options.requests?.push(path);
        const redirected = new URL(String(url)).origin === 'https://other.example.test';
        if (path === options.redirectPath && !redirected) {
          return new Response(null, { status: 307, headers: { Location: `https://other.example.test${path}` } });
        }
        if (redirected) {
          options.redirectedRequests?.push({
            authorizationPresent: new Headers(init?.headers).has('Authorization'),
            bodyPresent: init?.body != null,
          });
        }
        if (path === '/v1/account/encryption/currentness') {
          if (modeFailurePending) { modeFailurePending = false; return new Response(null, { status: 503 }); }
          return Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
        }
        if (path === '/v1/auth/pairing/start') {
          return new Response(JSON.stringify({ pairId: 'pair-1', expiresAt }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (path === '/v1/auth/pairing/status' && options.completePairing) {
          const invite = await emittedInvite;
          return new Response(JSON.stringify({
            state: 'requested',
            pairId: invite.pairId,
            expiresAt: new Date(invite.expiresAtMs).toISOString(),
            requestedPublicKey: encodeBase64(requesterPublicKey),
            requestedDeviceLabel: 'Phone',
            bindingProof: computeHomeQrBindingProofV2({
              direction: invite.direction,
              qrSecret: decodeBase64(invite.qrSecretBase64Url, 'base64url'),
              pairId: invite.pairId,
              homeServerIdentityId: invite.home.homeServerIdentityId,
              requesterPublicKey,
              expiresAtMs: invite.expiresAtMs,
            }),
            homeServerIdentityId: invite.home.homeServerIdentityId,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (path === '/v1/auth/account/response') {
          accountResponseBodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (path === '/v1/auth/pairing/status') {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('cancelled');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
        }
        if (path === '/v1/auth/pairing/consume') return new Response(null, { status: 204 });
        throw new Error(`Unexpected direct QR request: ${path}`);
      }));

      let inviteDescriptor: HomeConnectionDescriptorV1 | null = null;
      const result = await runCliDirectHomeQr({
        profileRef: profile.id,
        copyLink: true,
        signal: controller.signal,
        onInvite: ({ link }) => {
          try {
            const payload = new URL(link).searchParams.get('payload');
            const invite = payload
              ? parseHomeQrInviteV2Payload(payload, { nowMs: Date.now() })
              : null;
            inviteDescriptor = invite?.home ?? null;
            if (invite && options.completePairing) resolveEmittedInvite(invite);
          } finally {
            if (!options.completePairing) controller.abort();
          }
        },
      });
      return {
        result,
        inviteDescriptor,
        accountResponseBodies,
        profile: await profiles.getServerProfile(profile.id),
      };
    });
  }

  it('uses the authenticated newer descriptor generation in the emitted invite', async () => {
    const current = descriptor({ revision: 2 });
    const outcome = await runCase(descriptor({ revision: 1 }), current);

    expect(outcome.result).toEqual({ kind: 'cancelled' });
    expect(outcome.inviteDescriptor).toEqual(current);
    expect(outcome.profile.homeConnectionDescriptor).toEqual(current);
  });

  it('retries a transient authenticated mode read through the existing QR lifecycle', async () => {
    const stored = descriptor({ revision: 2 });
    const outcome = await runCase(stored, stored, true, { completePairing: true, transientModeFailure: true });
    expect(outcome.result).toEqual({ kind: 'completed', requestedDeviceLabel: 'Phone' });
    expect(outcome.accountResponseBodies).toEqual([expect.objectContaining({ responseKind: 'tokenOnly' })]);
  });

  it.each([
    '/v1/auth/pairing/status',
    '/v1/account/encryption/currentness',
  ])('completes pairing after a redirected %s read without forwarding credentials', async redirectPath => {
    const stored = descriptor({ revision: 2 });
    const redirectedRequests: Array<{ authorizationPresent: boolean; bodyPresent: boolean }> = [];
    const outcome = await runCase(stored, stored, true, { completePairing: true, redirectPath, redirectedRequests });
    expect(outcome.result).toEqual({ kind: 'completed', requestedDeviceLabel: 'Phone' });
    expect(redirectedRequests.length).toBeGreaterThan(0);
    expect(redirectedRequests.every(request => !request.authorizationPresent && !request.bodyPresent)).toBe(true);
    expect(carrierBoundary.close).toHaveBeenCalledOnce();
  });

  it.each([
    '/v1/auth/pairing/start',
    '/v1/auth/account/response',
  ])('refuses a cross-origin %s secret-body replay without retrying', async (redirectPath) => {
    const stored = descriptor({ revision: 2 });
    const requests: string[] = [];
    await expect(runCase(stored, stored, true, { completePairing: true, redirectPath, requests })).rejects.toMatchObject({
      code: 'credential_request_redirect_refused', retryable: false, status: 307,
    });
    expect(requests.filter((path) => path === redirectPath)).toHaveLength(1);
    expect(carrierBoundary.close).toHaveBeenCalledOnce();
  });

  it('completes an approved pairing for the pinned Home identity', async () => {
    const stored = descriptor({ revision: 2 });
    const outcome = await runCase(stored, stored, true, { completePairing: true });

    expect(outcome.result).toEqual({ kind: 'completed', requestedDeviceLabel: 'Phone' });
    expect(outcome.accountResponseBodies).toEqual([
      expect.objectContaining({
        pairId: 'pair-1',
        homeServerIdentityId: stored.homeServerIdentityId,
        responseKind: 'tokenOnly',
      }),
    ]);
  });

  it('reports cancellation when caller aborts during descriptor carrier acquisition', async () => {
    const stored = descriptor({ revision: 2 });
    const outcome = await runCase(stored, stored, true, { abortDuringAcquire: true });

    expect(outcome.result).toEqual({ kind: 'cancelled' });
    expect(featureBoundary.read).not.toHaveBeenCalled();
  });

  it('reports cancellation and closes the carrier when caller aborts before pairing starts', async () => {
    const stored = descriptor({ revision: 2 });
    const outcome = await runCase(stored, stored, true, { abortAfterFeatureRead: true });

    expect(outcome.result).toEqual({ kind: 'cancelled' });
    expect(carrierBoundary.close).toHaveBeenCalledOnce();
  });

  it('keeps the stored current generation when the authenticated observation is stale', async () => {
    const current = descriptor({ revision: 2 });
    const outcome = await runCase(current, descriptor({ revision: 1 }));

    expect(outcome.result).toEqual({ kind: 'cancelled' });
    expect(outcome.inviteDescriptor).toEqual(current);
    expect(outcome.profile.homeConnectionDescriptor).toEqual(current);
  });

  it('fails closed on equal-revision conflict before emitting an invite', async () => {
    const stored = descriptor({ revision: 2 });
    const conflicting = {
      ...stored,
      endpoints: [{ kind: 'https' as const, url: 'https://other-ingress.example.test' }],
    };
    const outcome = await runCase(stored, conflicting);

    expect(outcome.result).toEqual({ kind: 'failed', status: 412 });
    expect(outcome.inviteDescriptor).toBeNull();
    expect(outcome.profile.homeConnectionDescriptor).toEqual(stored);
  });

  it('fails closed when the authenticated descriptor belongs to another Home', async () => {
    const stored = descriptor({ revision: 2 });
    const outcome = await runCase(stored, descriptor({ revision: 3, identity: 'srv_other_home' }));

    expect(outcome.result).toEqual({ kind: 'failed', status: 412 });
    expect(outcome.inviteDescriptor).toBeNull();
    expect(outcome.profile.homeConnectionDescriptor).toEqual(stored);
  });

  it('does not persist an observed descriptor before the bound-QR capability admits the flow', async () => {
    const stored = descriptor({ revision: 1 });
    const observed = descriptor({ revision: 2 });
    const outcome = await runCase(stored, observed, false);

    expect(outcome.result).toEqual({ kind: 'update_required' });
    expect(outcome.inviteDescriptor).toBeNull();
    expect(outcome.profile.homeConnectionDescriptor).toEqual(stored);
  });

  it('does not publish a public compatibility projection as an exact QR descriptor', async () => {
    const stored = descriptor({ revision: 1 });
    const publicProjection = descriptor({ revision: 2 });
    const outcome = await runCase(stored, publicProjection, true, {
      observationProvenance: 'public',
    });

    expect(outcome.result).toEqual({ kind: 'update_required' });
    expect(outcome.inviteDescriptor).toBeNull();
    expect(outcome.profile.homeConnectionDescriptor).toEqual(stored);
  });
});
