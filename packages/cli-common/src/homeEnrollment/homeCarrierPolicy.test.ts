import { describe, expect, it, vi } from 'vitest';

import {
  acquireHomeCarrierByPolicy,
  drainRetainedHomeCarrierReleases,
  readHomeApplicationCarrierEligibilityFromEnv,
  hasRemoteHomeApplicationCarrier,
} from './homeCarrierPolicy';
import { enrollmentPollingBackoffMs } from './index';

const endpointId = 'a'.repeat(64);
const descriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_a',
  canonicalServerUrl: 'http://localhost:3010',
  revision: 7,
  endpoints: [
    { kind: 'https' as const, url: 'https://ingress.example.test/path/?ignored=yes#fragment' },
    { kind: 'iroh' as const, endpointId, relayUrls: ['https://relay.example.test/'] },
  ],
};

describe('client-local Home carrier selection', () => {
  it.each(['http://localhost:3039', 'http://qa.localhost:3039', 'http://127.0.0.1:3039', 'https://[::1]:3039'])(
    'distinguishes a local-only Home from routes usable by a separate guest (%s)', (url) => {
      const local = { ...descriptor, endpoints: [{ kind: 'https' as const, url }] };
      expect(hasRemoteHomeApplicationCarrier(local)).toBe(false);
      expect(hasRemoteHomeApplicationCarrier({ ...local, endpoints: [...local.endpoints, descriptor.endpoints[0]!] })).toBe(true);
      const peer = { ...local, endpoints: [...local.endpoints, descriptor.endpoints[1]!] };
      expect(hasRemoteHomeApplicationCarrier(peer)).toBe(true);
      expect(hasRemoteHomeApplicationCarrier(peer, 'standard_only')).toBe(false);
    },
  );

  it('selects Standard only from the operator environment and rejects unknown values', () => {
    expect(readHomeApplicationCarrierEligibilityFromEnv({})).toBe('automatic');
    expect(readHomeApplicationCarrierEligibilityFromEnv({ HAPPIER_HOME_CARRIER_POLICY: 'standard_only' })).toBe('standard_only');
    expect(readHomeApplicationCarrierEligibilityFromEnv({ HAPPIER_HOME_CARRIER_POLICY: 'AUTOMATIC' })).toBe('automatic');
    expect(() => readHomeApplicationCarrierEligibilityFromEnv({ HAPPIER_HOME_CARRIER_POLICY: 'disabled' }))
      .toThrow('HAPPIER_HOME_CARRIER_POLICY');
  });
});

describe('acquireHomeCarrierByPolicy', () => {
  it('bypasses Iroh entirely when application carriers are standard-only', async () => {
    const acquireIroh = vi.fn();

    await expect(acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      applicationCarrierEligibility: 'standard_only',
      descriptor,
      preferredTransport: 'iroh',
      acquireIroh,
      classifyFailure: () => ({ fallbackAllowed: false }),
    })).resolves.toEqual({ kind: 'https', runtimeOrigin: 'https://ingress.example.test/path' });
    expect(acquireIroh).not.toHaveBeenCalled();

    await expect(acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      applicationCarrierEligibility: 'standard_only',
      descriptor: { ...descriptor, endpoints: [descriptor.endpoints[1]!] },
      preferredTransport: 'iroh',
      acquireIroh,
      classifyFailure: () => ({ fallbackAllowed: true }),
    })).resolves.toMatchObject({
      kind: 'unavailable',
      error: { code: 'unavailable' },
    });
    expect(acquireIroh).not.toHaveBeenCalled();
  });

  it('selects a loopback-HTTP application endpoint, which is the only shape a local Home publishes', async () => {
    // `HomeApplicationOriginV1Schema` approves HTTPS *or* loopback HTTP, so a Home reachable
    // only at `http://<host>.localhost:<port>` publishes exactly this endpoint. Refusing it here
    // left such a Home with no application carrier at all and made enrollment impossible.
    const acquireIroh = vi.fn();

    await expect(acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_local',
        canonicalServerUrl: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'http://happier-repo-dev-a1cc5e0671.localhost:53288' }],
      },
      preferredTransport: 'https',
      acquireIroh,
      classifyFailure: () => ({ fallbackAllowed: false }),
    })).resolves.toEqual({
      kind: 'https',
      runtimeOrigin: 'http://happier-repo-dev-a1cc5e0671.localhost:53288',
    });
    expect(acquireIroh).not.toHaveBeenCalled();
  });

  it('prefers a public HTTPS ingress over a loopback entry declared before it', async () => {
    // Loopback reaches only this machine, so it is the last resort and never preempts an
    // independent ingress, whatever order the descriptor lists them in.
    await expect(acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_both',
        canonicalServerUrl: 'http://localhost:3010',
        revision: 1,
        endpoints: [
          { kind: 'https' as const, url: 'http://localhost:3010' },
          { kind: 'https' as const, url: 'https://home-b.example.test' },
        ],
      },
      preferredTransport: 'https',
      acquireIroh: vi.fn(),
      classifyFailure: () => ({ fallbackAllowed: false }),
    })).resolves.toEqual({ kind: 'https', runtimeOrigin: 'https://home-b.example.test' });
  });

  it('still refuses a non-loopback plaintext application endpoint', async () => {
    await expect(acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor: {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_remote',
        canonicalServerUrl: 'https://home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'http://home.example.test' }],
      },
      preferredTransport: 'https',
      acquireIroh: vi.fn(),
      classifyFailure: () => ({ fallbackAllowed: false }),
    })).resolves.toMatchObject({ kind: 'unavailable', error: { code: 'unavailable' } });
  });

  it('selects Iroh first and accepts only the exact descriptor identity and EndpointId', async () => {
    const release = vi.fn(async () => undefined);
    const acquireIroh = vi.fn(async () => ({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      endpointId,
      status: 'ready' as const,
      release,
      value: { runtimeOrigin: 'http://127.0.0.1:43123' },
    }));

    const result = await acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor,
      preferredTransport: 'iroh',
      acquireIroh,
      classifyFailure: () => ({ fallbackAllowed: false }),
    });

    expect(acquireIroh).toHaveBeenCalledWith({ descriptor, endpoint: descriptor.endpoints[1] });
    expect(result).toMatchObject({
      kind: 'iroh',
      carrier: { homeServerIdentityId: 'srv_home_a', endpointId, status: 'ready' },
    });
    expect(release).not.toHaveBeenCalled();
  });

  it('rejects a target preference that contradicts descriptor-owned Iroh-first policy', async () => {
    const acquireIroh = vi.fn();
    const result = await acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor,
      preferredTransport: 'https',
      acquireIroh,
      classifyFailure: () => ({ fallbackAllowed: true }),
    });

    expect(result).toMatchObject({
      kind: 'fail_closed',
      error: { code: 'invalid_preference' },
      fallbackAllowed: false,
    });
    expect(acquireIroh).not.toHaveBeenCalled();
  });

  it.each([
    ['identity', { homeServerIdentityId: 'srv_home_b', endpointId, status: 'ready' as const }],
    ['endpoint', { homeServerIdentityId: 'srv_home_a', endpointId: 'b'.repeat(64), status: 'ready' as const }],
    ['readiness', { homeServerIdentityId: 'srv_home_a', endpointId, status: 'degraded' as const }],
  ])('fails closed and releases an acquired carrier with mismatched %s', async (_label, returned) => {
    const release = vi.fn(async () => undefined);
    const result = await acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor,
      preferredTransport: 'iroh',
      acquireIroh: async () => ({ ...returned, release, value: null }),
      classifyFailure: () => ({ fallbackAllowed: true }),
    });

    expect(result).toMatchObject({ kind: 'fail_closed', fallbackAllowed: false });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('falls back only for classified availability and only to descriptor-declared HTTPS', async () => {
    const unavailable = new Error('Iroh unavailable');
    const result = await acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor,
      preferredTransport: 'iroh',
      acquireIroh: async () => { throw unavailable; },
      classifyFailure: (error) => ({ fallbackAllowed: error === unavailable }),
    });

    expect(result).toEqual({ kind: 'https', runtimeOrigin: 'https://ingress.example.test/path' });
  });

  it.each(['identity', 'config', 'protocol'])('does not fall back for %s failures', async () => {
    const error = new Error('fail closed');
    await expect(acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor,
      preferredTransport: 'iroh',
      acquireIroh: async () => { throw error; },
      classifyFailure: () => ({ fallbackAllowed: false }),
    })).resolves.toEqual({ kind: 'fail_closed', error, fallbackAllowed: false });
  });

  it('keeps pinned recovery on Iroh when acquisition is safely unavailable', async () => {
    const unavailable = new Error('Iroh suspended');
    await expect(acquireHomeCarrierByPolicy({
      mode: 'pinned_recovery',
      descriptor,
      preferredTransport: 'iroh',
      acquireIroh: async () => { throw unavailable; },
      classifyFailure: () => ({ fallbackAllowed: true }),
    })).resolves.toEqual({
      kind: 'fail_closed',
      error: unavailable,
      fallbackAllowed: true,
    });
  });

  it('does not publish HTTPS during pinned recovery when the refreshed descriptor no longer declares Iroh', async () => {
    const acquireIroh = vi.fn();
    await expect(acquireHomeCarrierByPolicy({
      mode: 'pinned_recovery',
      descriptor: { ...descriptor, endpoints: [descriptor.endpoints[0]!] },
      preferredTransport: 'https',
      acquireIroh,
      classifyFailure: () => ({ fallbackAllowed: true }),
    })).resolves.toMatchObject({
      kind: 'fail_closed',
      error: { code: 'unavailable' },
      fallbackAllowed: false,
    });
    expect(acquireIroh).not.toHaveBeenCalled();
  });

  it('keeps failed release custody retryable at the explicit drain boundary', async () => {
    const release = vi.fn()
      .mockRejectedValueOnce(new Error('release failed'))
      .mockResolvedValueOnce(undefined);
    const result = await acquireHomeCarrierByPolicy({
      mode: 'initial_selection',
      descriptor,
      preferredTransport: 'iroh',
      acquireIroh: async () => ({
        homeServerIdentityId: descriptor.homeServerIdentityId,
        endpointId,
        status: 'ready',
        release,
        value: null,
      }),
      classifyFailure: () => ({ fallbackAllowed: false }),
    });
    expect(result.kind).toBe('iroh');
    if (result.kind !== 'iroh') return;

    await expect(result.release()).rejects.toThrow('release failed');
    await drainRetainedHomeCarrierReleases();
    await expect(result.release()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
  });
});

describe('enrollmentPollingBackoffMs', () => {
  it('backs off bounded enrollment polling and retains bounded jitter', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect([1, 2, 3, 4, 5].map(enrollmentPollingBackoffMs)).toEqual([
        1_000,
        2_000,
        4_000,
        5_000,
        5_000,
      ]);
      random.mockReturnValue(0.999);
      expect(enrollmentPollingBackoffMs(4)).toBe(5_249);
    } finally {
      random.mockRestore();
    }
  });
});
