import { createLoopbackTunnelStore } from './store';
import type { LoopbackTunnelAdapter, LoopbackTunnelLease, LoopbackTunnelProbe, LoopbackTunnelRequest, LoopbackTunnelSupervisor } from './types';

/** Lifecycle-only owner; native adapters retain all socket and byte-copy ownership. */
export function createLoopbackTunnelSupervisor<Request extends LoopbackTunnelRequest, Lease extends LoopbackTunnelLease>(input: Readonly<{
  adapter: LoopbackTunnelAdapter<Request>;
  probe: LoopbackTunnelProbe;
  buildKey: (request: Request) => string;
  createLease: (value: { key: string; request: Request; localPort: number; generation?: number }) => Lease;
  probeTimeoutMs?: number;
  getGeneration?: () => number;
}>): LoopbackTunnelSupervisor<Request, Lease> {
  const store = createLoopbackTunnelStore<Lease, never>({});
  const pending = new Map<string, { promise: Promise<Lease>; referenceCount: number }>();
  const probeTimeoutMs = input.probeTimeoutMs ?? 15_000;
  async function runProbe(url: string): Promise<Awaited<ReturnType<LoopbackTunnelProbe>>> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([input.probe(url), new Promise<Awaited<ReturnType<LoopbackTunnelProbe>>>((resolve) => {
        timeout = setTimeout(() => resolve({ ok: false, reason: 'probe-timeout' }), probeTimeoutMs);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
  return {
    async ensureTunnel(request) {
      if (store.isSuspended()) throw new Error('loopback_tunnel_suspended');
      const key = input.buildKey(request);
      const stored = store.getByKey(key);
      if (stored?.lease.status === 'ready' && stored.lease.localUrl) {
        const health = await runProbe(stored.lease.localUrl);
        if (health.ok) {
          const retained = store.retain(key);
          if (retained) return retained.lease;
        } else {
          if (stored.nativeTunnelId) await input.adapter.stopLoopbackTunnel(stored.nativeTunnelId);
          store.deleteByKey(key);
        }
      }
      const existing = pending.get(key);
      if (existing) { existing.referenceCount += 1; return await existing.promise; }
      const generation = input.getGeneration?.();
      const start = (async () => {
        const native = await input.adapter.startLoopbackTunnel(request);
        const localUrl = `http://127.0.0.1:${native.localPort}`;
        const probe = await runProbe(localUrl);
        if (!probe.ok) {
          await input.adapter.stopLoopbackTunnel(native.nativeTunnelId);
          throw new Error(`loopback_tunnel_probe_failed:${probe.reason}`);
        }
        if (generation !== undefined && input.getGeneration?.() !== generation) {
          await input.adapter.stopLoopbackTunnel(native.nativeTunnelId);
          throw new Error('loopback_tunnel_stale_generation');
        }
        const lease = input.createLease({ key, request, localPort: native.localPort, generation });
        store.put(key, { lease, nativeTunnelId: native.nativeTunnelId, referenceCount: pending.get(key)?.referenceCount ?? 1 });
        return lease;
      })();
      pending.set(key, { promise: start, referenceCount: 1 });
      try { return await start; } finally { pending.delete(key); }
    },
    listTunnels: () => store.snapshot(),
    async releaseTunnel(leaseId) {
      const result = store.releaseByLeaseId(leaseId);
      if (!result?.released) return;
      try {
        if (result.stored.nativeTunnelId) await input.adapter.stopLoopbackTunnel(result.stored.nativeTunnelId);
        store.removeReleasedLease(leaseId);
      } catch (error) { store.updateStatus(leaseId, 'failed'); throw error; }
    },
    markSuspended: () => store.markSuspended(),
    async markForeground() {
      store.markForeground();
      for (const lease of store.snapshot().leases) {
        if (!lease.localUrl) continue;
        const probe = await runProbe(lease.localUrl);
        if (probe.ok) { store.updateStatus(lease.leaseId, 'ready'); continue; }
        store.updateStatus(lease.leaseId, 'degraded');
        const stored = store.getByKey(lease.key);
        if (stored?.nativeTunnelId) {
          await input.adapter.stopLoopbackTunnel(stored.nativeTunnelId);
          store.deleteByKey(lease.key);
        }
      }
    },
  };
}
