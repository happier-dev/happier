import { describe, expect, it, vi } from 'vitest';

import type { NativeSshTunnelLease, NativeSshTunnelSnapshot, NativeSshTunnelSupervisor } from './types';

function createLease(status: NativeSshTunnelLease['status'] = 'ready'): NativeSshTunnelLease {
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

function createSupervisor(): NativeSshTunnelSupervisor {
    let snapshot: NativeSshTunnelSnapshot = {
        leases: [],
        platformLimitations: [],
    };

    return {
        ensureTunnel: vi.fn(async () => {
            snapshot = {
                ...snapshot,
                leases: [createLease()],
            };
            return createLease();
        }),
        listTunnels: vi.fn(() => snapshot),
        releaseTunnel: vi.fn(async () => {
            snapshot = {
                ...snapshot,
                leases: [],
            };
        }),
        markSuspended: vi.fn(() => {
            snapshot = {
                leases: snapshot.leases.map(() => createLease('degraded')),
                platformLimitations: [{
                    id: 'native-ssh.platform-suspended',
                    severity: 'warning',
                    reason: 'platform-suspended',
                    message: 'settings.accessEndpoints.limitation.platform-suspended',
                }],
            };
        }),
        markForeground: vi.fn(async () => {
            snapshot = {
                leases: snapshot.leases.map(() => createLease('ready')),
                platformLimitations: [],
            };
        }),
    };
}

function createRequest() {
    return {
        remoteHostId: 'host-a',
        sshTarget: 'dev@10.0.0.5',
        destinationHost: '127.0.0.1' as const,
        destinationPort: 3005,
        purpose: 'server-http' as const,
        credentialsRef: {
            remoteHostId: 'host-a',
            credentialId: 'cred-a',
            storage: 'session-memory' as const,
        },
    };
}

describe('app native SSH tunnel runtime', () => {
    it('keeps one canonical singleton and notifies subscribers after snapshot updates', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        const supervisor = createSupervisor();
        const firstRuntime = loaded!.getNativeSshTunnelRuntime({
            createSupervisor: () => supervisor,
        });
        const secondRuntime = loaded!.getNativeSshTunnelRuntime({
            createSupervisor: () => createSupervisor(),
        });
        expect(secondRuntime).toBe(firstRuntime);

        const snapshots: NativeSshTunnelSnapshot[] = [];
        const unsubscribe = firstRuntime.subscribe(() => {
            snapshots.push(firstRuntime.listTunnels());
        });

        await firstRuntime.ensureTunnel(createRequest());
        unsubscribe();
        await firstRuntime.releaseTunnel('lease-a');

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.leases.map((lease) => lease.leaseId)).toEqual(['lease-a']);
        expect(firstRuntime.listTunnels().leases).toEqual([]);

        loaded!.disposeNativeSshTunnelRuntime();
    });

    it('degrades leases on background AppState changes and re-probes on foreground', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        let listener: ((state: 'active' | 'background' | 'inactive') => void | Promise<void>) | null = null;
        const remove = vi.fn();
        const appState = {
            currentState: 'active' as const,
            addEventListener: vi.fn((_event: 'change', nextListener: (state: 'active' | 'background' | 'inactive') => void | Promise<void>) => {
                listener = nextListener;
                return { remove };
            }),
        };
        const supervisor = createSupervisor();
        const runtime = loaded!.createNativeSshTunnelRuntime({ supervisor });
        await runtime.ensureTunnel(createRequest());

        const lifecycle = loaded!.bindNativeSshTunnelRuntimeAppState({
            appState,
            runtime,
        });
        const emitAppState = async (state: 'active' | 'background' | 'inactive') => {
            const currentListener = listener;
            if (!currentListener) {
                throw new Error('AppState listener was not registered');
            }
            await currentListener(state);
        };

        await emitAppState('background');
        expect(runtime.listTunnels().leases[0]?.status).toBe('degraded');
        expect(runtime.listTunnels().platformLimitations.map((limitation) => limitation.reason)).toContain('platform-suspended');

        await emitAppState('active');
        expect(runtime.listTunnels().leases[0]?.status).toBe('ready');
        expect(supervisor.markForeground).toHaveBeenCalledTimes(1);

        lifecycle.remove();
        expect(remove).toHaveBeenCalledTimes(1);
    });

    it('rejects new tunnel starts while the native app is suspended', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        const supervisor = createSupervisor();
        const runtime = loaded!.createNativeSshTunnelRuntime({ supervisor });

        runtime.markSuspended();

        await expect(runtime.ensureTunnel(createRequest())).rejects.toThrow('native_ssh_tunnel_suspended');
        expect(supervisor.ensureTunnel).not.toHaveBeenCalled();
        loaded!.disposeNativeSshTunnelRuntime();
    });

    it('keys credential material by the full credential ref and clears it when the lease is released', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        const lease = createLease();
        let released = false;
        const supervisor: NativeSshTunnelSupervisor = {
            ensureTunnel: vi.fn(async () => lease),
            listTunnels: vi.fn(() => ({ leases: released ? [] : [lease], platformLimitations: [] })),
            releaseTunnel: vi.fn(async () => {
                released = true;
            }),
            markSuspended: vi.fn(),
            markForeground: vi.fn(async () => undefined),
        };
        const runtime = loaded!.createNativeSshTunnelRuntime({
            supervisor,
        });

        const credentialsRef = createRequest().credentialsRef;
        loaded!.setNativeSshTunnelCredentialResolution(credentialsRef, {
            auth: {
                username: 'dev',
                password: 'secret-a',
            },
        });
        loaded!.setNativeSshTunnelCredentialResolution({
            remoteHostId: 'host-a',
            credentialId: 'cred-b',
            storage: 'session-memory',
        }, {
            auth: {
                username: 'dev',
                password: 'secret-b',
            },
        });

        await runtime.ensureTunnel(createRequest());
        await runtime.releaseTunnel('lease-a');

        expect(loaded!.readNativeSshTunnelCredentialResolution(credentialsRef)).toBeNull();
        expect(loaded!.readNativeSshTunnelCredentialResolution({
            remoteHostId: 'host-a',
            credentialId: 'cred-b',
            storage: 'session-memory',
        })).toEqual({
            auth: {
                username: 'dev',
                password: 'secret-b',
            },
        });
        loaded!.disposeNativeSshTunnelRuntime();
    });

    it('keeps credential material while a shared lease remains retained', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        let releaseCalls = 0;
        const lease = createLease();
        const supervisor: NativeSshTunnelSupervisor = {
            ensureTunnel: vi.fn(async () => lease),
            listTunnels: vi.fn(() => ({
                leases: releaseCalls < 2 ? [lease] : [],
                platformLimitations: [],
            })),
            releaseTunnel: vi.fn(async () => {
                releaseCalls += 1;
            }),
            markSuspended: vi.fn(),
            markForeground: vi.fn(async () => undefined),
        };
        const runtime = loaded!.createNativeSshTunnelRuntime({ supervisor });
        const credentialsRef = createRequest().credentialsRef;
        loaded!.setNativeSshTunnelCredentialResolution(credentialsRef, {
            auth: {
                username: 'dev',
                password: 'secret-a',
            },
        });

        await runtime.ensureTunnel(createRequest());
        await runtime.releaseTunnel('lease-a');

        expect(loaded!.readNativeSshTunnelCredentialResolution(credentialsRef)).toEqual({
            auth: {
                username: 'dev',
                password: 'secret-a',
            },
        });

        await runtime.releaseTunnel('lease-a');
        expect(loaded!.readNativeSshTunnelCredentialResolution(credentialsRef)).toBeNull();
        loaded!.disposeNativeSshTunnelRuntime();
    });

    it('clears every credential ref that reused the same lease after final release', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        let releaseCalls = 0;
        const lease = createLease();
        const supervisor: NativeSshTunnelSupervisor = {
            ensureTunnel: vi.fn(async () => lease),
            listTunnels: vi.fn(() => ({
                leases: releaseCalls < 2 ? [lease] : [],
                platformLimitations: [],
            })),
            releaseTunnel: vi.fn(async () => {
                releaseCalls += 1;
            }),
            markSuspended: vi.fn(),
            markForeground: vi.fn(async () => undefined),
        };
        const runtime = loaded!.createNativeSshTunnelRuntime({ supervisor });
        const firstRef = createRequest().credentialsRef;
        const secondRef = {
            remoteHostId: 'host-a',
            credentialId: 'cred-b',
            storage: 'session-memory' as const,
        };
        loaded!.setNativeSshTunnelCredentialResolution(firstRef, {
            auth: {
                username: 'dev',
                password: 'secret-a',
            },
        });
        loaded!.setNativeSshTunnelCredentialResolution(secondRef, {
            auth: {
                username: 'dev',
                password: 'secret-b',
            },
        });

        await runtime.ensureTunnel(createRequest());
        await runtime.ensureTunnel({
            ...createRequest(),
            credentialsRef: secondRef,
        });
        await runtime.releaseTunnel('lease-a');

        expect(loaded!.readNativeSshTunnelCredentialResolution(firstRef)).toEqual({
            auth: {
                username: 'dev',
                password: 'secret-a',
            },
        });
        expect(loaded!.readNativeSshTunnelCredentialResolution(secondRef)).toEqual({
            auth: {
                username: 'dev',
                password: 'secret-b',
            },
        });

        await runtime.releaseTunnel('lease-a');
        expect(loaded!.readNativeSshTunnelCredentialResolution(firstRef)).toBeNull();
        expect(loaded!.readNativeSshTunnelCredentialResolution(secondRef)).toBeNull();
        loaded!.disposeNativeSshTunnelRuntime();
    });

    it('clears credential material when tunnel establishment fails', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        const supervisor: NativeSshTunnelSupervisor = {
            ensureTunnel: vi.fn(async () => {
                throw new Error('native_ssh_tunnel_probe_failed');
            }),
            listTunnels: vi.fn(() => ({ leases: [], platformLimitations: [] })),
            releaseTunnel: vi.fn(async () => undefined),
            markSuspended: vi.fn(),
            markForeground: vi.fn(async () => undefined),
        };
        const runtime = loaded!.createNativeSshTunnelRuntime({ supervisor });
        const credentialsRef = createRequest().credentialsRef;
        loaded!.setNativeSshTunnelCredentialResolution(credentialsRef, {
            auth: {
                username: 'dev',
                password: 'secret-a',
            },
        });

        await expect(runtime.ensureTunnel(createRequest())).rejects.toThrow('native_ssh_tunnel_probe_failed');

        expect(loaded!.readNativeSshTunnelCredentialResolution(credentialsRef)).toBeNull();
        loaded!.disposeNativeSshTunnelRuntime();
    });

    it('clears credential material when final native tunnel release fails', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        const lease = createLease();
        const supervisor: NativeSshTunnelSupervisor = {
            ensureTunnel: vi.fn(async () => lease),
            listTunnels: vi.fn(() => ({ leases: [lease], platformLimitations: [] })),
            releaseTunnel: vi.fn(async () => {
                throw new Error('native_stop_failed');
            }),
            markSuspended: vi.fn(),
            markForeground: vi.fn(async () => undefined),
        };
        const runtime = loaded!.createNativeSshTunnelRuntime({ supervisor });
        const credentialsRef = createRequest().credentialsRef;
        loaded!.setNativeSshTunnelCredentialResolution(credentialsRef, {
            auth: {
                username: 'dev',
                password: 'secret-a',
            },
        });

        await runtime.ensureTunnel(createRequest());
        await expect(runtime.releaseTunnel('lease-a')).rejects.toThrow('native_stop_failed');

        expect(loaded!.readNativeSshTunnelCredentialResolution(credentialsRef)).toBeNull();
        loaded!.disposeNativeSshTunnelRuntime();
    });
});
