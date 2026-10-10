import { describe, expect, it, vi } from 'vitest';
import type { NativeSshModule } from '@happier-dev/ssh-native';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import type { NativeSshTunnelLease, NativeSshTunnelSnapshot, NativeSshTunnelSupervisor } from './types';

// Only the native SDK and the external socket/HTTP transports are replaced in the Account-lifecycle case.
let nativeModule: NativeSshModule | null = null;
vi.mock('@happier-dev/ssh-native', async importOriginal => ({
    ...await importOriginal<typeof import('@happier-dev/ssh-native')>(),
    getOptionalHappierSshNativeModule: () => nativeModule,
}));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

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
        dispose: vi.fn(async () => { snapshot = { leases: [], platformLimitations: [] }; }),
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
    it('withdraws pending native acceptance on Account retirement while the incumbent subscriber follows the next Account', async () => {
        const pendingReached = createDeferred<void>();
        const finishPending = createDeferred<void>();
        const releaseReached = createDeferred<void>();
        const finishRelease = createDeferred<void>();
        const liveHandles = new Set<string>();
        nativeModule = {
            getAvailability: () => ({ available: true, platform: 'android', engine: 'russh', moduleVersion: '0.0.0',
                supportsLoopbackTunnel: true, supportsPersistentHostKeyStorage: false }),
            exec: vi.fn(), cancelRequest: vi.fn(async () => undefined),
            startLoopbackTunnel: async request => {
                const pending = request.destinationPort === 3006;
                if (pending) { pendingReached.resolve(); await finishPending.promise; }
                const nativeTunnelId = pending ? 'native-pending-a' : request.auth.password === 'password-b' ? 'native-ready-b' : 'native-ready-a';
                const localPort = pending ? 49153 : 49152;
                liveHandles.add(nativeTunnelId);
                return { nativeTunnelId, localPort };
            },
            stopLoopbackTunnel: async nativeTunnelId => {
                if (nativeTunnelId === 'native-ready-a') { releaseReached.resolve(); await finishRelease.promise; }
                liveHandles.delete(nativeTunnelId);
            },
        } satisfies NativeSshModule;
        vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.hostname === '127.0.0.1' && url.pathname === '/health') return Response.json({ ok: true });
            throw new Error(`Unexpected native acceptance HTTP request: ${url.origin}${url.pathname}`);
        });
        const request = async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ version: 0, content: { t: 'plain', v: {} } });
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            return Response.json({}, { status: 404 });
        };
        const owner = await import('./runtime');
        await owner.disposeNativeSshTunnelRuntime();
        let accountA: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        let accountB: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        let unsubscribe: (() => void) | undefined;
        let pending: Promise<Readonly<{ ok: boolean }>> | undefined;
        let releasing: Promise<void> | undefined;
        try {
            await loadSyncSingletonForTests();
            accountA = await restoreServerAccountForTest({ serverUrl: 'https://pending-native-home.example', accountId: 'account-a', request });
            const scopes = await import('@/sync/domains/scope/activeServerAccountScope');
            const lifetimeA = scopes.captureActiveServerAccountScopeLifetime();
            expect(lifetimeA?.scope.accountId).toBe('account-a');
            const caller = await import('@/components/settings/remoteHosts/remoteHostOutcomeActions');
            const config = { sshTarget: 'dev@10.0.0.5', sshPort: null, sshAuth: 'password' as const,
                password: 'password-a', identityFilePath: '', identityPrivateKey: '', sshConfigFilePath: '' };
            const tunnel = caller.buildNativeSshTunnelRequestFromRemoteHostConfig({ remoteHostId: 'host-a', config });
            const credentialsA = caller.buildNativeSshTunnelCredentialsFromRemoteHostConfig(config);
            if (!credentialsA) throw new Error('Expected native password material');
            owner.setNativeSshTunnelCredentialResolution(tunnel.credentialsRef, credentialsA);
            const runtime = owner.getNativeSshTunnelRuntime();
            const snapshots: NativeSshTunnelSnapshot[] = [];
            unsubscribe = runtime.subscribe(() => snapshots.push(runtime.listTunnels()));
            const firstLease = await runtime.ensureTunnel(tunnel);
            releasing = runtime.releaseTunnel(firstLease.leaseId);
            await releaseReached.promise;
            pending = runtime.ensureTunnel({ ...tunnel, destinationPort: 3006 })
                .then(() => ({ ok: true }), () => ({ ok: false }));
            await pendingReached.promise;
            await accountA.dispose();
            accountA = undefined;
            expect(lifetimeA?.isCurrent()).toBe(false);
            expect.soft(owner.readNativeSshTunnelCredentialResolution(tunnel.credentialsRef)).toBeNull();
            expect.soft(runtime.listTunnels().leases).toEqual([]);
            expect.soft(snapshots.at(-1)?.leases).toEqual([]);
            accountB = await restoreServerAccountForTest({ serverUrl: 'https://pending-native-home.example', accountId: 'account-b', request });
            expect(scopes.getActiveServerAccountScope()?.accountId).toBe('account-b');
            const credentialsB = caller.buildNativeSshTunnelCredentialsFromRemoteHostConfig({ ...config, password: 'password-b' });
            if (!credentialsB) throw new Error('Expected native password material');
            owner.setNativeSshTunnelCredentialResolution(tunnel.credentialsRef, credentialsB);
            expect(owner.readNativeSshTunnelCredentialResolution(tunnel.credentialsRef)).toEqual(credentialsB);
            // Join the incumbent disposal while its old SDK start is still
            // held; B's admitted material must survive A's later rejection.
            const retirement = runtime.dispose();
            finishRelease.resolve();
            await releasing;
            expect.soft(owner.readNativeSshTunnelCredentialResolution(tunnel.credentialsRef)).toEqual(credentialsB);
            // B may re-admit the same addressed credential while A's other
            // accepted operation is still settling; neither old cleanup owns it.
            owner.setNativeSshTunnelCredentialResolution(tunnel.credentialsRef, credentialsB);
            finishPending.resolve();
            expect.soft(await pending).toEqual({ ok: false });
            await retirement;
            expect.soft(owner.readNativeSshTunnelCredentialResolution(tunnel.credentialsRef)).toEqual(credentialsB);
            expect.soft(owner.getNativeSshTunnelRuntime()).toBe(runtime);
            const leaseB = await owner.getNativeSshTunnelRuntime().ensureTunnel(tunnel);
            expect.soft([...liveHandles]).toEqual(['native-ready-b']);
            expect.soft(snapshots.at(-1)?.leases.map(lease => lease.leaseId)).toEqual([leaseB.leaseId]);
        } finally {
            finishRelease.resolve();
            finishPending.resolve();
            await releasing;
            await pending;
            unsubscribe?.();
            await accountB?.dispose();
            await accountA?.dispose();
            const runtime = owner.getNativeSshTunnelRuntime();
            for (const lease of runtime.listTunnels().leases) {
                await runtime.releaseTunnel(lease.leaseId);
                await runtime.releaseTunnel(lease.leaseId);
            }
            await owner.disposeNativeSshTunnelRuntime();
            nativeModule = null;
        }
    });

    it('withdraws retired Account credentials and does not reuse its authenticated lease for the same host in another Account', async () => {
        const liveNativeHandles = new Set<string>();
        const nativeStart = vi.fn<NonNullable<NativeSshModule['startLoopbackTunnel']>>(async request => {
            if (request.auth.password !== 'account-a-password') throw Object.assign(new Error('SSH authentication failed'), { code: 'authentication-failed' });
            liveNativeHandles.add('native-account-a');
            return { nativeTunnelId: 'native-account-a', localPort: 49152 };
        });
        nativeModule = { getAvailability: () => ({ available: true, platform: 'android', engine: 'russh', moduleVersion: '0.0.0',
            supportsLoopbackTunnel: true, supportsPersistentHostKeyStorage: false }),
            exec: vi.fn(), cancelRequest: vi.fn(async () => undefined), startLoopbackTunnel: nativeStart,
            stopLoopbackTunnel: vi.fn(async nativeTunnelId => { liveNativeHandles.delete(nativeTunnelId); }) } satisfies NativeSshModule;
        vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.hostname === '127.0.0.1' && url.pathname === '/health') {
                return Response.json({ ok: liveNativeHandles.size > 0 }, { status: liveNativeHandles.size > 0 ? 200 : 503 });
            }
            throw new Error(`Unexpected native tunnel test HTTP request: ${url.origin}${url.pathname}`);
        });
        const request = async (input: string | URL | Request) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ version: 0, content: { t: 'plain', v: {} } });
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            return Response.json({}, { status: 404 });
        };
        let accountA: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        let accountB: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        const owner = await import('./runtime');
        await owner.disposeNativeSshTunnelRuntime();
        try {
            await loadSyncSingletonForTests();
            accountA = await restoreServerAccountForTest({ serverUrl: 'https://native-account-home.example', accountId: 'account-a', request });
            const scopes = await import('@/sync/domains/scope/activeServerAccountScope');
            const lifetimeA = scopes.captureActiveServerAccountScopeLifetime();
            expect(lifetimeA?.scope.accountId).toBe('account-a');
            const caller = await import('@/components/settings/remoteHosts/remoteHostOutcomeActions');
            const config = { sshTarget: 'dev@10.0.0.5', sshPort: null, sshAuth: 'password' as const,
                password: 'account-a-password', identityFilePath: '', identityPrivateKey: '', sshConfigFilePath: '' };
            const tunnel = caller.buildNativeSshTunnelRequestFromRemoteHostConfig({ remoteHostId: 'host-a', config });
            const credentialsA = caller.buildNativeSshTunnelCredentialsFromRemoteHostConfig(config);
            if (!credentialsA) throw new Error('Expected admitted native password material');
            owner.setNativeSshTunnelCredentialResolution(tunnel.credentialsRef, credentialsA);
            const runtime = owner.getNativeSshTunnelRuntime();
            const firstLease = await runtime.ensureTunnel(tunnel);
            const sharedLease = await runtime.ensureTunnel(tunnel);
            expect(sharedLease.leaseId).toBe(firstLease.leaseId);
            expect([...liveNativeHandles]).toEqual(['native-account-a']);
            expect(nativeStart).toHaveBeenCalledWith(expect.objectContaining({ auth: { username: 'dev', password: 'account-a-password' } }));

            // This is an actual sign-out/sign-in, not a second cold restore over
            // a mounted Account whose credential boundary still answers for A.
            await accountA.dispose();
            accountA = undefined;
            expect(lifetimeA?.isCurrent()).toBe(false);
            // Retirement must revoke the OS transport capability, not merely prevent one later caller from borrowing it.
            expect.soft([...liveNativeHandles]).toEqual([]);
            expect.soft(owner.readNativeSshTunnelCredentialResolution(tunnel.credentialsRef)).toBeNull();
            accountB = await restoreServerAccountForTest({ serverUrl: 'https://native-account-home.example', accountId: 'account-b', request });
            expect(scopes.getActiveServerAccountScope()?.accountId).toBe('account-b');
            const credentialsB = caller.buildNativeSshTunnelCredentialsFromRemoteHostConfig({ ...config, password: 'invalid-account-b-password' });
            if (!credentialsB) throw new Error('Expected admitted native password material');
            owner.setNativeSshTunnelCredentialResolution(tunnel.credentialsRef, credentialsB);
            // A healthy Account-A transport cannot stand in for authenticating Account B's admitted input.
            await expect(owner.getNativeSshTunnelRuntime().ensureTunnel(tunnel)).rejects.toMatchObject({ code: 'authentication-failed' });
        } finally {
            await accountB?.dispose();
            await accountA?.dispose();
            const runtime = owner.getNativeSshTunnelRuntime();
            for (const lease of runtime.listTunnels().leases) {
                // This case made at most three acquisitions of the same concrete lease.
                await runtime.releaseTunnel(lease.leaseId);
                await runtime.releaseTunnel(lease.leaseId);
                await runtime.releaseTunnel(lease.leaseId);
            }
            await owner.disposeNativeSshTunnelRuntime();
            nativeModule = null;
        }
    });

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

        await loaded!.disposeNativeSshTunnelRuntime();
    });

    it('rejects new tunnel starts while the native app is suspended', async () => {
        const loaded = await import('./runtime').catch(() => null);
        expect(loaded).not.toBeNull();

        const supervisor = createSupervisor();
        const runtime = loaded!.createNativeSshTunnelRuntime({ supervisor });

        runtime.markSuspended();

        await expect(runtime.ensureTunnel(createRequest())).rejects.toThrow('native_ssh_tunnel_suspended');
        expect(supervisor.ensureTunnel).not.toHaveBeenCalled();
        await loaded!.disposeNativeSshTunnelRuntime();
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
            dispose: vi.fn(async () => undefined),
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
        await loaded!.disposeNativeSshTunnelRuntime();
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
            dispose: vi.fn(async () => undefined),
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
        await loaded!.disposeNativeSshTunnelRuntime();
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
            dispose: vi.fn(async () => undefined),
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
        await loaded!.disposeNativeSshTunnelRuntime();
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
            dispose: vi.fn(async () => undefined),
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
        await loaded!.disposeNativeSshTunnelRuntime();
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
            dispose: vi.fn(async () => undefined),
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
        await loaded!.disposeNativeSshTunnelRuntime();
    });
});
