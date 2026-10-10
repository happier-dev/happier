import { describe, expect, it, vi } from 'vitest';

import { bindNativeLoopbackTunnelRuntimeActivity } from './runtime';
import { createNativeSshTunnelRuntime } from '@/sync/runtime/nativeSshTunnels/runtime';
import type {
    NativeSshTunnelLease,
    NativeSshTunnelSnapshot,
    NativeSshTunnelSupervisor,
} from '@/sync/runtime/nativeSshTunnels/types';

function createSshLease(status: NativeSshTunnelLease['status'] = 'ready'): NativeSshTunnelLease {
    return {
        leaseId: 'lease-a',
        key: 'key-a',
        remoteHostId: 'host-a',
        localUrl: 'http://127.0.0.1:49152',
        channelMode: 'loopback-port',
        purpose: 'server-http',
        status,
        startedAt: '2026-05-06T10:00:00.000Z',
    };
}

function createSshSupervisor(): NativeSshTunnelSupervisor {
    let snapshot: NativeSshTunnelSnapshot = { leases: [], platformLimitations: [] };
    return {
        ensureTunnel: vi.fn(async () => {
            snapshot = { ...snapshot, leases: [createSshLease()] };
            return createSshLease();
        }),
        listTunnels: vi.fn(() => snapshot),
        releaseTunnel: vi.fn(async () => {
            snapshot = { ...snapshot, leases: [] };
        }),
        markSuspended: vi.fn(() => {
            snapshot = {
                leases: snapshot.leases.map(() => createSshLease('degraded')),
                platformLimitations: [{
                    id: 'native-ssh.platform-suspended',
                    severity: 'warning',
                    reason: 'platform-suspended',
                    message: 'settings.accessEndpoints.limitation.platform-suspended',
                }],
            };
        }),
        markForeground: vi.fn(async () => {
            snapshot = { leases: snapshot.leases.map(() => createSshLease()), platformLimitations: [] };
        }),
        dispose: vi.fn(async () => { snapshot = { leases: [], platformLimitations: [] }; }),
    };
}

describe('native loopback tunnel runtime activity', () => {
    it('drives the composed SSH runtime through suspended and recovered lease state', async () => {
        let active = true;
        let listener: (() => void | Promise<void>) | null = null;
        const supervisor = createSshSupervisor();
        const runtime = createNativeSshTunnelRuntime({ supervisor });
        await runtime.ensureTunnel({
            remoteHostId: 'host-a',
            sshTarget: 'dev@10.0.0.5',
            destinationHost: '127.0.0.1',
            destinationPort: 3005,
            purpose: 'server-http',
            credentialsRef: {
                remoteHostId: 'host-a',
                credentialId: 'cred-a',
                storage: 'session-memory',
            },
        });
        const lifecycle = bindNativeLoopbackTunnelRuntimeActivity({
            isActive: () => active,
            subscribe: (nextListener) => {
                listener = nextListener;
                return () => undefined;
            },
            runtimes: [runtime],
        });
        const emit = async (nextActive: boolean) => {
            active = nextActive;
            if (!listener) throw new Error('Runtime-activity listener was not registered');
            await listener();
        };

        await emit(false);
        expect(runtime.listTunnels().leases[0]?.status).toBe('degraded');
        expect(runtime.listTunnels().platformLimitations.map((limitation) => limitation.reason))
            .toContain('platform-suspended');

        await emit(true);
        expect(runtime.listTunnels().leases[0]?.status).toBe('ready');

        lifecycle.remove();
    });

    it('drives every native loopback runtime from one provider-neutral activity owner', async () => {
        let active = true;
        let listener: (() => void | Promise<void>) | null = null;
        const unsubscribe = vi.fn();
        const runtimes = [
            { markSuspended: vi.fn(), markForeground: vi.fn(async () => undefined) },
            { markSuspended: vi.fn(), markForeground: vi.fn(async () => undefined) },
            { markSuspended: vi.fn(), markForeground: vi.fn(async () => undefined) },
        ];

        const lifecycle = bindNativeLoopbackTunnelRuntimeActivity({
            isActive: () => active,
            subscribe: (nextListener) => {
                listener = nextListener;
                return unsubscribe;
            },
            runtimes,
        });
        const emitActivityChange = async (nextActive: boolean) => {
            active = nextActive;
            const currentListener = listener;
            if (!currentListener) throw new Error('Runtime-activity listener was not registered');
            await currentListener();
        };

        await emitActivityChange(false);
        for (const runtime of runtimes) expect(runtime.markSuspended).toHaveBeenCalledTimes(1);

        await emitActivityChange(true);
        for (const runtime of runtimes) expect(runtime.markForeground).toHaveBeenCalledTimes(1);

        lifecycle.remove();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('attempts foreground recovery for every runtime when one runtime fails', async () => {
        let active = false;
        const listenerRef: { current: (() => void | Promise<void>) | null } = { current: null };
        const failingRuntime = {
            markSuspended: vi.fn(),
            markForeground: vi.fn(async () => {
                throw new Error('foreground recovery failed');
            }),
        };
        const healthyRuntime = {
            markSuspended: vi.fn(),
            markForeground: vi.fn(async () => undefined),
        };
        const lifecycle = bindNativeLoopbackTunnelRuntimeActivity({
            isActive: () => active,
            subscribe: (nextListener) => {
                listenerRef.current = nextListener;
                return () => undefined;
            },
            runtimes: [failingRuntime, healthyRuntime],
        });
        const currentListener = listenerRef.current;
        if (!currentListener) throw new Error('Runtime-activity listener was not registered');

        active = true;
        await expect(currentListener()).resolves.toBeUndefined();
        expect(failingRuntime.markForeground).toHaveBeenCalledTimes(1);
        expect(healthyRuntime.markForeground).toHaveBeenCalledTimes(1);

        lifecycle.remove();
    });
});
