import { describe, expect, it, vi } from 'vitest';

import { createIrohNativeAdapter, createOptionalIrohNativeAdapter } from './adapter';
import { IrohError } from './errors';

// The Expo native module lookup is a genuine system boundary (native module
// availability); the adapter mapping logic under test below stays real.
const optionalNativeModule = vi.hoisted(() => ({
  getAvailability: vi.fn(() => ({ available: true })),
  createEndpoint: vi.fn(),
  ensureHomeTunnel: vi.fn(),
  releaseHomeTunnel: vi.fn(),
  shutdownEndpoint: vi.fn(),
  getTunnelStatus: vi.fn(),
}));

vi.mock('./HappierIrohNative', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./HappierIrohNative')>();
  return { ...actual, getOptionalHappierIrohNativeModule: () => optionalNativeModule };
});

const LEASE_BASE = {
  leaseId: 'l1',
  homeServerIdentityId: 'srv_home_a',
  homeEndpointId: 'endpoint-a',
  runtimeOrigin: 'http://127.0.0.1:1234',
  carrier: 'iroh' as const,
  observedPath: 'direct' as const,
  startedAtMs: 1,
};

function nativeHarness(overrides: Partial<Parameters<typeof createIrohNativeAdapter>[0]> = {}) {
  return {
    ensureHomeTunnel: vi.fn(async () => ({ ...LEASE_BASE })),
    releaseHomeTunnel: vi.fn(async () => undefined),
    getTunnelStatus: vi.fn(async () => ({
      active: true,
      connectionActive: true,
      observedPath: 'direct' as const,
    })),
    ...overrides,
  };
}

describe('Iroh native lifecycle adapter', () => {
  it('carries policy and descriptor fields verbatim through the injected native lifecycle seam', async () => {
    const native = nativeHarness();
    const adapter = createIrohNativeAdapter(native);
    await adapter.ensureHomeTunnel({
      homeServerIdentityId: 'srv_home_a',
      endpointId: 'endpoint-a',
      policy: 'automatic',
      relayUrls: ['https://relay.example.test'],
      endpointKeyPath: '/data/runtime/iroh/endpoint.key',
    });
    expect(native.ensureHomeTunnel).toHaveBeenCalledWith(expect.objectContaining({
      homeServerIdentityId: 'srv_home_a',
      endpointId: 'endpoint-a',
      // The injected lifecycle seam takes the adapter request verbatim; the
      // policy → relayPolicy rename belongs to the native module boundary.
      policy: 'automatic',
      relayUrls: ['https://relay.example.test'],
      endpointKeyPath: '/data/runtime/iroh/endpoint.key',
    }));
  });

  it('creates one persistent application endpoint and ensures every Home by exact handle', async () => {
    optionalNativeModule.createEndpoint.mockResolvedValue({
      endpointHandle: 'application-endpoint', endpointId: 'client-endpoint',
      relayPolicy: 'disabled', relayMode: 'disabled', capProfile: 'homeInteractive', relayUrls: [],
    });
    optionalNativeModule.ensureHomeTunnel
      .mockResolvedValueOnce({ ...LEASE_BASE, tunnelId: 'l1' })
      .mockResolvedValueOnce({ ...LEASE_BASE, leaseId: 'l2', tunnelId: 'l2', homeServerIdentityId: 'srv_home_b' });
    const adapter = createOptionalIrohNativeAdapter();
    await adapter.ensureHomeTunnel({
      homeServerIdentityId: 'srv_home_a',
      endpointId: 'endpoint-a',
      policy: 'disabled',
      directAddresses: ['127.0.0.1:4242'],
      relayUrls: ['https://relay.example.test'],
      endpointKeyPath: '/data/runtime/iroh/endpoint.key',
    });
    await adapter.ensureHomeTunnel({
      homeServerIdentityId: 'srv_home_b', endpointId: 'endpoint-a', policy: 'disabled',
    });
    expect(optionalNativeModule.createEndpoint).toHaveBeenCalledTimes(2);
    expect(optionalNativeModule.createEndpoint).toHaveBeenNthCalledWith(1, {
      keyPath: '/data/runtime/iroh/endpoint.key',
      relayPolicy: 'disabled',
      relayUrls: ['https://relay.example.test'],
    });
    expect(optionalNativeModule.createEndpoint).toHaveBeenNthCalledWith(2, {
      relayPolicy: 'disabled',
    });
    expect(optionalNativeModule.ensureHomeTunnel).toHaveBeenNthCalledWith(1, {
      endpointHandle: 'application-endpoint',
      homeServerIdentityId: 'srv_home_a',
      endpointId: 'endpoint-a',
      directAddresses: ['127.0.0.1:4242'],
      relayUrls: ['https://relay.example.test'],
    });
  });

  it('normalizes Expo coded native failures into the canonical Iroh error', async () => {
    optionalNativeModule.createEndpoint.mockRejectedValueOnce(
      Object.assign(new Error('Iroh endpoint identity is unavailable.'), {
        code: 'endpoint_key_unavailable',
      }),
    );
    const adapter = createOptionalIrohNativeAdapter();

    await expect(adapter.ensureHomeTunnel({
      homeServerIdentityId: 'srv_home_a',
      endpointId: 'endpoint-a',
      policy: 'automatic',
    })).rejects.toMatchObject({
      name: 'IrohError',
      code: 'endpoint_key_unavailable',
    });
  });

  it('canonicalizes IrohError subclasses before they reach shared classifiers', async () => {
    const operationError = new IrohError('transport_closed', 'peer disconnected');
    operationError.name = 'IrohNativeOperationError';
    const native = nativeHarness({
      ensureHomeTunnel: vi.fn(async () => { throw operationError; }),
    });
    const adapter = createIrohNativeAdapter(native);

    await expect(adapter.ensureHomeTunnel({
      homeServerIdentityId: 'srv_home_a',
      endpointId: 'endpoint-a',
      policy: 'automatic',
    })).rejects.toMatchObject({ name: 'IrohError', code: 'transport_closed' });
  });

  it('fails closed when native returns a lease for a different Home identity', async () => {
    const native = nativeHarness({
      ensureHomeTunnel: vi.fn(async () => ({ ...LEASE_BASE, homeServerIdentityId: 'srv_home_b' })),
    });
    const adapter = createIrohNativeAdapter(native);
    await expect(adapter.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic' }))
      .rejects.toMatchObject({ code: 'identity_mismatch' });
    // The misrouted lease must be released, never adopted for the wrong Home.
    expect(native.releaseHomeTunnel).toHaveBeenCalledWith('l1');
  });

  it('fails closed when native returns a lease bound to a different endpoint identity', async () => {
    const native = nativeHarness({
      ensureHomeTunnel: vi.fn(async () => ({ ...LEASE_BASE, homeEndpointId: 'endpoint-stale' })),
    });
    const adapter = createIrohNativeAdapter(native);
    await expect(adapter.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic' }))
      .rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(native.releaseHomeTunnel).toHaveBeenCalledWith('l1');
  });

  it('retains custody of a mismatched lease whose immediate release failed and retries it at the next release boundary', async () => {
    const releaseHomeTunnel = vi.fn(async (leaseId: string) => {
      if (leaseId === 'l1' && releaseHomeTunnel.mock.calls.length === 1) {
        throw new Error('native release failed');
      }
    });
    const native = nativeHarness({
      ensureHomeTunnel: vi.fn()
        .mockResolvedValueOnce({ ...LEASE_BASE, homeServerIdentityId: 'srv_home_b' })
        .mockResolvedValueOnce({ ...LEASE_BASE, leaseId: 'l2' }),
      releaseHomeTunnel,
    });
    vi.useFakeTimers();
    try {
      const adapter = createIrohNativeAdapter(native, { statusPollIntervalMs: 100 });

      await expect(adapter.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic' }))
        .rejects.toMatchObject({ code: 'identity_mismatch' });
      expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
      // The retained lease is never adopted: it never becomes an observable
      // lease, so no consumer can subscribe to or use it for any Home.
      adapter.subscribeEvents('l1', () => undefined);
      await vi.advanceTimersByTimeAsync(300);
      expect(native.getTunnelStatus).not.toHaveBeenCalled();

      const lease = await adapter.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic' });
      expect(lease.leaseId).toBe('l2');
      await adapter.releaseHomeTunnel('l2');

      expect(releaseHomeTunnel.mock.calls.map(([id]) => id)).toEqual(['l1', 'l2', 'l1']);

      // Idempotent: once the retained release succeeds it is dropped, so a
      // later terminal boundary does not release the same native lease again.
      await adapter.dispose();
      expect(releaseHomeTunnel.mock.calls.map(([id]) => id)).toEqual(['l1', 'l2', 'l1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retained custody across a failing dispose and retries it at the next dispose', async () => {
    const releaseHomeTunnel = vi.fn(async (leaseId: string) => {
      if (leaseId === 'l1' && releaseHomeTunnel.mock.calls.length <= 2) {
        throw new Error('native release failed');
      }
    });
    const native = nativeHarness({
      ensureHomeTunnel: vi.fn(async () => ({ ...LEASE_BASE, homeEndpointId: 'endpoint-stale' })),
      releaseHomeTunnel,
    });
    const adapter = createIrohNativeAdapter(native);

    await expect(adapter.ensureHomeTunnel({ homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic' }))
      .rejects.toMatchObject({ code: 'identity_mismatch' });

    // Disposal is terminal: an unreleased native lease is reported so the
    // caller keeps this adapter owned instead of orphaning native custody.
    await expect(adapter.dispose()).rejects.toThrow('native release failed');
    await adapter.dispose();
    expect(releaseHomeTunnel.mock.calls.map(([id]) => id)).toEqual(['l1', 'l1', 'l1']);
  });

  it('releases owned leases and stops polling at dispose', async () => {
    vi.useFakeTimers();
    try {
      const native = nativeHarness();
      const adapter = createIrohNativeAdapter(native, { statusPollIntervalMs: 100 });
      const lease = await adapter.ensureHomeTunnel({
        homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic',
      });
      adapter.subscribeEvents(lease.leaseId, () => undefined);
      await vi.advanceTimersByTimeAsync(100);
      const pollsBeforeDispose = native.getTunnelStatus.mock.calls.length;

      await adapter.dispose();
      await vi.advanceTimersByTimeAsync(300);

      expect(native.releaseHomeTunnel).toHaveBeenCalledWith('l1');
      expect(native.getTunnelStatus).toHaveBeenCalledTimes(pollsBeforeDispose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes the typed identity-mismatch failure code', () => {
    expect(new IrohError('identity_mismatch', 'test').code).toBe('identity_mismatch');
  });

  it('normalizes polled native transport facts into coalesced lifecycle events without Home identity data', async () => {
    vi.useFakeTimers();
    try {
      const getTunnelStatus = vi.fn()
        .mockResolvedValueOnce({ active: true, connectionActive: true, observedPath: 'direct' })
        .mockResolvedValueOnce({ active: true, connectionActive: true, observedPath: 'relay' })
        // Rust retains the tunnel entry after Connection::closed completes.
        .mockResolvedValue({ active: true, connectionActive: false, observedPath: 'relay' });
      const adapter = createIrohNativeAdapter(nativeHarness({ getTunnelStatus }), { statusPollIntervalMs: 100 });
      const lease = await adapter.ensureHomeTunnel({
        homeServerIdentityId: 'srv_home_a',
        endpointId: 'endpoint-a',
        policy: 'automatic',
      });
      const events: unknown[] = [];
      const unsubscribe = adapter.subscribeEvents(lease.leaseId, (event) => events.push(event));

      await vi.advanceTimersByTimeAsync(400);

      expect(events).toEqual([
        expect.objectContaining({ type: 'ready', tunnelHandle: 'l1', status: 'ready', observedPath: 'direct' }),
        expect.objectContaining({ type: 'path_changed', tunnelHandle: 'l1', status: 'ready', observedPath: 'relay' }),
        expect.objectContaining({ type: 'closed', tunnelHandle: 'l1', status: 'closed' }),
      ]);
      for (const event of events) {
        expect(event).not.toHaveProperty('homeServerIdentityId');
        expect(event).not.toHaveProperty('runtimeOrigin');
        expect(event).not.toHaveProperty('descriptorRevision');
      }
      unsubscribe();
      await vi.advanceTimersByTimeAsync(200);
      expect(getTunnelStatus).toHaveBeenCalledTimes(3);
      expect(getTunnelStatus).toHaveBeenCalledWith('l1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a transient status failure and continues observing the same owned lease', async () => {
    vi.useFakeTimers();
    try {
      const getTunnelStatus = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('status read failed'), { code: 'unknown' }))
        .mockResolvedValueOnce({ active: true, connectionActive: true, observedPath: 'direct' });
      const native = nativeHarness({ getTunnelStatus });
      const adapter = createIrohNativeAdapter(native, { statusPollIntervalMs: 100 });
      const lease = await adapter.ensureHomeTunnel({
        homeServerIdentityId: 'srv_home_a',
        endpointId: 'endpoint-a',
        policy: 'automatic',
      });
      const events: unknown[] = [];
      adapter.subscribeEvents(lease.leaseId, (event) => events.push(event));

      // Subscription reads once immediately, then uses the existing cadence.
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toEqual([
        expect.objectContaining({ type: 'error', tunnelHandle: 'l1', status: 'error', errorCode: 'unknown' }),
        expect.objectContaining({ type: 'ready', tunnelHandle: 'l1', status: 'ready', observedPath: 'direct' }),
      ]);

      await adapter.releaseHomeTunnel(lease.leaseId);
      await vi.advanceTimersByTimeAsync(300);
      expect(getTunnelStatus).toHaveBeenCalledTimes(2);
      expect(native.releaseHomeTunnel).toHaveBeenCalledWith('l1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads current status immediately for exact tunnel handles when two leases belong to the same Home', async () => {
    vi.useFakeTimers();
    try {
      const getTunnelStatus = vi.fn(async (tunnelId: string) => ({
        active: true,
        connectionActive: true,
        observedPath: tunnelId === 'l1' ? 'direct' : 'relay',
      }));
      const native = nativeHarness({
        ensureHomeTunnel: vi.fn()
          .mockResolvedValueOnce({ ...LEASE_BASE, leaseId: 'l1' })
          .mockResolvedValueOnce({ ...LEASE_BASE, leaseId: 'l2' }),
        getTunnelStatus,
      });
      const adapter = createIrohNativeAdapter(native, { statusPollIntervalMs: 100 });
      const request = { homeServerIdentityId: 'srv_home_a', endpointId: 'endpoint-a', policy: 'automatic' as const };
      const first = await adapter.ensureHomeTunnel(request);
      const second = await adapter.ensureHomeTunnel(request);
      const events: unknown[] = [];
      adapter.subscribeEvents(first.leaseId, (event) => events.push(event));
      adapter.subscribeEvents(second.leaseId, (event) => events.push(event));

      await vi.advanceTimersByTimeAsync(0);

      expect(getTunnelStatus.mock.calls.map(([tunnelId]) => tunnelId).sort()).toEqual(['l1', 'l2']);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ tunnelHandle: 'l1', observedPath: 'direct' }),
        expect.objectContaining({ tunnelHandle: 'l2', observedPath: 'relay' }),
      ]));
      await adapter.releaseHomeTunnel(first.leaseId);
      await adapter.releaseHomeTunnel(second.leaseId);
    } finally {
      vi.useRealTimers();
    }
  });
});
