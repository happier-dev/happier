import { describe, expect, it, vi } from 'vitest';

describe('UI Iroh lifecycle adapter', () => {
    it('publishes runtime origin on lease and clears it on release', async () => {
        vi.resetModules();
        const update = vi.fn();
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({ updateActiveServerRuntimeOrigin: update }));
        const { createUiIrohNativeAdapter } = await import('./adapter');
        const native = {
            ensureHomeTunnel: vi.fn(async () => ({ leaseId: 'l1', homeServerIdentityId: 'home', homeEndpointId: 'e1', runtimeOrigin: 'http://127.0.0.1:1234', carrier: 'iroh' as const, observedPath: 'direct' as const, startedAtMs: 1 })),
            releaseHomeTunnel: vi.fn(async () => undefined),
        };
        const adapter = createUiIrohNativeAdapter({ native });
        await adapter.ensureHomeTunnel({ homeServerIdentityId: 'home', endpointId: 'e1', policy: 'automatic' });
        expect(update).toHaveBeenCalledWith({ runtimeOrigin: 'http://127.0.0.1:1234', carrier: 'iroh' });
        await adapter.releaseHomeTunnel('l1');
        expect(update).toHaveBeenLastCalledWith({ carrier: 'https' });
    });

    it('releases and rejects a lease that resolves after a server generation switch', async () => {
        vi.resetModules();
        const update = vi.fn();
        vi.doMock('@/sync/domains/server/serverRuntime', () => ({ updateActiveServerRuntimeOrigin: update }));
        const { createUiIrohNativeAdapter } = await import('./adapter');
        let generation = 1;
        let resolveNative: ((value: { leaseId: string; homeServerIdentityId: string; homeEndpointId: string; runtimeOrigin: string; carrier: 'iroh'; observedPath: 'direct'; startedAtMs: number }) => void) | undefined;
        const native = {
            ensureHomeTunnel: vi.fn(async () => await new Promise((resolve) => { resolveNative = resolve; })),
            releaseHomeTunnel: vi.fn(async () => undefined),
        };
        const fenced = createUiIrohNativeAdapter({ native, getGeneration: () => generation });
        const pending = fenced.ensureHomeTunnel({ homeServerIdentityId: 'home', endpointId: 'e1', policy: 'automatic' });
        generation = 2;
        resolveNative?.({ leaseId: 'stale', homeServerIdentityId: 'home', homeEndpointId: 'e1', runtimeOrigin: 'http://127.0.0.1:1234', carrier: 'iroh', observedPath: 'direct', startedAtMs: 1 });
        await expect(pending).rejects.toThrow('iroh_home_tunnel_stale_generation');
        expect(native.releaseHomeTunnel).toHaveBeenCalledWith('stale');
        expect(update).not.toHaveBeenCalled();
    });
});
