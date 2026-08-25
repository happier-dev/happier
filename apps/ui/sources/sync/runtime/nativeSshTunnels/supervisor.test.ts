import { describe, expect, it, vi } from 'vitest';

import { buildAccessEndpointProjection } from '@/sync/domains/accessEndpoints/buildProjection';
import { buildAccessChannelProjection } from '@/sync/domains/accessEndpoints/channels/buildProjection';

import type { NativeSshTunnelAdapter, NativeSshTunnelProbe } from './types';

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

describe('native SSH tunnel supervisor', () => {
    it('reuses a ready lease only after a successful health probe', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe = vi.fn(async (_url: string) => ({ ok: true as const }));
        const supervisor = loaded!.createNativeSshTunnelSupervisor({ adapter, probe });

        const firstLease = await supervisor.ensureTunnel(createRequest());
        const secondLease = await supervisor.ensureTunnel(createRequest());

        expect(secondLease.leaseId).toBe(firstLease.leaseId);
        expect(adapter.startLoopbackTunnel).toHaveBeenCalledTimes(1);
        expect(probe).toHaveBeenCalledTimes(2);
    });

    it('stops a native tunnel if post-start validation fails', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({
                ok: false as const,
                reason: 'remote-service-unreachable' as const,
            })),
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('native_ssh_tunnel_probe_failed');
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
    });

    it('stops a native tunnel if post-start validation times out', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const hangingProbe: NativeSshTunnelProbe = async () => new Promise(() => {});
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(hangingProbe),
            probeTimeoutMs: 1,
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('native_ssh_tunnel_probe_failed');
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        expect(supervisor.listTunnels().leases).toEqual([]);
        expect(supervisor.listTunnels().platformLimitations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                reason: 'remote-service-unreachable',
                severity: 'error',
            }),
        ]));
    });

    it('exposes probe failure diagnostics as platform limitations', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({
                ok: false as const,
                reason: 'network-captive-portal' as const,
            })),
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('native_ssh_tunnel_probe_failed');

        expect(supervisor.listTunnels().platformLimitations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                reason: 'network-captive-portal',
                severity: 'error',
            }),
        ]));
    });

    it('exposes native start diagnostic codes as platform limitations', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const error = Object.assign(new Error('Native SSH loopback bind failed.'), {
            code: 'loopback-bind-failed',
        });
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter: {
                startLoopbackTunnel: vi.fn(async () => {
                    throw error;
                }),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            },
            probe: vi.fn(async () => ({ ok: true as const })),
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('Native SSH loopback bind failed.');

        expect(supervisor.listTunnels().platformLimitations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                reason: 'loopback-bind-failed',
                severity: 'error',
            }),
        ]));
    });

    it('clears stale start diagnostics after a later successful tunnel', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const error = Object.assign(new Error('Native SSH authentication failed.'), {
            code: 'authentication-failed',
        });
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter: {
                startLoopbackTunnel: vi.fn()
                    .mockRejectedValueOnce(error)
                    .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 }),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            },
            probe: vi.fn(async () => ({ ok: true as const })),
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('Native SSH authentication failed.');
        expect(supervisor.listTunnels().platformLimitations.map((limitation) => limitation.reason))
            .toContain('authentication-failed');

        await supervisor.ensureTunnel(createRequest());

        expect(supervisor.listTunnels().platformLimitations.map((limitation) => limitation.reason))
            .not.toContain('authentication-failed');
    });

    it('dedupes concurrent ensure calls for the same tunnel key', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        let resolveStart: (value: { nativeTunnelId: string; localPort: number }) => void = () => {
            throw new Error('start promise was not initialized');
        };
        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => new Promise<{
                nativeTunnelId: string;
                localPort: number;
            }>((resolve) => {
                resolveStart = resolve;
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({ ok: true as const })),
        });

        const first = supervisor.ensureTunnel(createRequest());
        const second = supervisor.ensureTunnel(createRequest());
        resolveStart({ nativeTunnelId: 'native-1', localPort: 49152 });

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ leaseId: 'native-ssh:' + loaded!.buildNativeSshTunnelKey(createRequest()) }),
            expect.objectContaining({ leaseId: 'native-ssh:' + loaded!.buildNativeSshTunnelKey(createRequest()) }),
        ]);
        expect(adapter.startLoopbackTunnel).toHaveBeenCalledTimes(1);
    });

    it('dedupes concurrent replacement of a stale ready tunnel', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const pendingReplacementStarts: Array<(value: { nativeTunnelId: string; localPort: number }) => void> = [];
        const startLoopbackTunnel = vi.fn(async () => {
            if (startLoopbackTunnel.mock.calls.length === 1) {
                return { nativeTunnelId: 'native-1', localPort: 49152 };
            }
            return await new Promise<{ nativeTunnelId: string; localPort: number }>((resolve) => {
                pendingReplacementStarts.push(resolve);
            });
        });
        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel,
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe = vi.fn()
            .mockResolvedValueOnce({ ok: true as const })
            .mockResolvedValueOnce({ ok: false as const, reason: 'remote-service-unreachable' as const })
            .mockResolvedValue({ ok: true as const });
        const supervisor = loaded!.createNativeSshTunnelSupervisor({ adapter, probe });

        await supervisor.ensureTunnel(createRequest());
        const firstReplacement = supervisor.ensureTunnel(createRequest());
        const secondReplacement = supervisor.ensureTunnel(createRequest());
        await vi.waitFor(() => {
            expect(pendingReplacementStarts.length).toBe(1);
        });
        pendingReplacementStarts[0]?.({ nativeTunnelId: 'native-2', localPort: 49153 });

        await expect(Promise.all([firstReplacement, secondReplacement])).resolves.toEqual([
            expect.objectContaining({ localUrl: 'http://127.0.0.1:49153' }),
            expect.objectContaining({ localUrl: 'http://127.0.0.1:49153' }),
        ]);
        expect(adapter.startLoopbackTunnel).toHaveBeenCalledTimes(2);
    });

    it('counts every concurrent ensure caller as a lease reference', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        let resolveStart: (value: { nativeTunnelId: string; localPort: number }) => void = () => {
            throw new Error('start promise was not initialized');
        };
        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => new Promise<{
                nativeTunnelId: string;
                localPort: number;
            }>((resolve) => {
                resolveStart = resolve;
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({ ok: true as const })),
        });

        const first = supervisor.ensureTunnel(createRequest());
        const second = supervisor.ensureTunnel(createRequest());
        resolveStart({ nativeTunnelId: 'native-1', localPort: 49152 });
        const [firstLease, secondLease] = await Promise.all([first, second]);

        await supervisor.releaseTunnel(firstLease.leaseId);
        expect(supervisor.listTunnels().leases.map((lease) => lease.leaseId)).toEqual([secondLease.leaseId]);
        expect(adapter.stopLoopbackTunnel).not.toHaveBeenCalled();

        await supervisor.releaseTunnel(secondLease.leaseId);
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
    });

    it('keeps a shared tunnel alive until every consumer releases the lease', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({ ok: true as const })),
        });

        const firstLease = await supervisor.ensureTunnel(createRequest());
        const secondLease = await supervisor.ensureTunnel(createRequest());

        await supervisor.releaseTunnel(firstLease.leaseId);
        expect(supervisor.listTunnels().leases.map((lease) => lease.leaseId)).toEqual([secondLease.leaseId]);
        expect(adapter.stopLoopbackTunnel).not.toHaveBeenCalled();

        await supervisor.releaseTunnel(secondLease.leaseId);
        expect(supervisor.listTunnels().leases).toEqual([]);
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
    });

    it('keeps released lease bookkeeping when native tunnel stop fails', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn(async () => {
                throw new Error('native_stop_failed');
            }),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({ ok: true as const })),
        });

        const lease = await supervisor.ensureTunnel(createRequest());
        await expect(supervisor.releaseTunnel(lease.leaseId)).rejects.toThrow('native_stop_failed');

        expect(supervisor.listTunnels().leases).toEqual([expect.objectContaining({
            leaseId: lease.leaseId,
            status: 'failed',
        })]);
    });

    it('stops stale ready tunnels before replacing them', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn()
                .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                .mockResolvedValueOnce({ nativeTunnelId: 'native-2', localPort: 49153 }),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe = vi.fn()
            .mockResolvedValueOnce({ ok: true as const })
            .mockResolvedValueOnce({ ok: false as const, reason: 'remote-service-unreachable' as const })
            .mockResolvedValueOnce({ ok: true as const });
        const supervisor = loaded!.createNativeSshTunnelSupervisor({ adapter, probe });

        await supervisor.ensureTunnel(createRequest());
        await supervisor.ensureTunnel(createRequest());

        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        expect(adapter.startLoopbackTunnel).toHaveBeenCalledTimes(2);
    });

    it('preserves retained consumer references when replacing a degraded stale tunnel', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn()
                .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                .mockResolvedValueOnce({ nativeTunnelId: 'native-2', localPort: 49153 }),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe = vi.fn()
            .mockResolvedValueOnce({ ok: true as const })
            .mockResolvedValueOnce({ ok: true as const })
            .mockResolvedValueOnce({ ok: false as const, reason: 'remote-service-unreachable' as const })
            .mockResolvedValueOnce({ ok: true as const });
        const supervisor = loaded!.createNativeSshTunnelSupervisor({ adapter, probe });

        const firstLease = await supervisor.ensureTunnel(createRequest());
        const secondLease = await supervisor.ensureTunnel(createRequest());
        const replacementLease = await supervisor.ensureTunnel(createRequest());

        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        expect(replacementLease.localUrl).toBe('http://127.0.0.1:49153');

        await supervisor.releaseTunnel(firstLease.leaseId);
        await supervisor.releaseTunnel(secondLease.leaseId);
        expect(adapter.stopLoopbackTunnel).not.toHaveBeenCalledWith('native-2');
        expect(supervisor.listTunnels().leases).toEqual([
            expect.objectContaining({
                leaseId: replacementLease.leaseId,
                localUrl: 'http://127.0.0.1:49153',
                status: 'ready',
            }),
        ]);

        await supervisor.releaseTunnel(replacementLease.leaseId);
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-2');
    });

    it('preserves a degraded stale lease when reprobe fails and re-establish cannot start', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn()
                .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                .mockRejectedValueOnce(new Error('native_start_failed')),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe = vi.fn()
            .mockResolvedValueOnce({ ok: true as const })
            .mockResolvedValueOnce({ ok: false as const, reason: 'remote-service-unreachable' as const });
        const supervisor = loaded!.createNativeSshTunnelSupervisor({ adapter, probe });

        const firstLease = await supervisor.ensureTunnel(createRequest());
        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('native_start_failed');

        expect(supervisor.listTunnels().leases).toEqual([
            expect.objectContaining({
                leaseId: firstLease.leaseId,
                key: firstLease.key,
                status: 'degraded',
                localUrl: firstLease.localUrl,
            }),
        ]);
        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
    });

    it('stops failed foreground leases before replacing them', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn()
                .mockResolvedValueOnce({ nativeTunnelId: 'native-1', localPort: 49152 })
                .mockResolvedValueOnce({ nativeTunnelId: 'native-2', localPort: 49153 }),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe = vi.fn()
            .mockResolvedValueOnce({ ok: true as const })
            .mockResolvedValueOnce({ ok: false as const, reason: 'remote-service-unreachable' as const })
            .mockResolvedValueOnce({ ok: true as const });
        const supervisor = loaded!.createNativeSshTunnelSupervisor({ adapter, probe });

        await supervisor.ensureTunnel(createRequest());
        await supervisor.markForeground();
        expect(supervisor.listTunnels().leases[0]?.status).toBe('failed');

        await supervisor.ensureTunnel(createRequest());

        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        expect(supervisor.listTunnels().leases[0]).toEqual(expect.objectContaining({
            localUrl: 'http://127.0.0.1:49153',
            status: 'ready',
        }));
    });

    it('stops failed foreground native tunnels immediately after reprobe failure', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const probe = vi.fn()
            .mockResolvedValueOnce({ ok: true as const })
            .mockResolvedValueOnce({ ok: false as const, reason: 'remote-service-unreachable' as const });
        const supervisor = loaded!.createNativeSshTunnelSupervisor({ adapter, probe });

        await supervisor.ensureTunnel(createRequest());
        await supervisor.markForeground();

        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledWith('native-1');
        expect(supervisor.listTunnels().leases[0]).toEqual(expect.objectContaining({
            status: 'failed',
        }));
    });

    it('keeps a failed lease so probe-cleanup stop failures can be retried on release', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({
                nativeTunnelId: 'native-1',
                localPort: 49152,
            })),
            stopLoopbackTunnel: vi.fn()
                .mockRejectedValueOnce(new Error('native_stop_failed'))
                .mockResolvedValueOnce(undefined),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({
                ok: false as const,
                reason: 'remote-service-unreachable' as const,
            })),
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('native_stop_failed');
        const failedLease = supervisor.listTunnels().leases[0];
        expect(failedLease).toEqual(expect.objectContaining({
            status: 'failed',
            localUrl: 'http://127.0.0.1:49152',
        }));

        await supervisor.releaseTunnel(failedLease!.leaseId);

        expect(adapter.stopLoopbackTunnel).toHaveBeenCalledTimes(2);
        expect(supervisor.listTunnels().leases).toEqual([]);
    });

    it('normalizes SSH targets and exposes suspended platform limitations', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const key = loaded!.buildNativeSshTunnelKey({
            ...createRequest(),
            sshTarget: 'dev@HOST.Example.COM',
        });
        expect(key).toBe(loaded!.buildNativeSshTunnelKey({
            ...createRequest(),
            sshTarget: 'dev@host.example.com',
        }));
        expect(key).not.toContain('HOST.Example.COM');

        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter: {
                startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
                stopLoopbackTunnel: vi.fn(async () => undefined),
            },
            probe: vi.fn(async () => ({ ok: true as const })),
        });
        await supervisor.ensureTunnel(createRequest());
        supervisor.markSuspended();

        expect(supervisor.listTunnels().platformLimitations.map((limitation) => limitation.reason)).toEqual(expect.arrayContaining([
            'foreground-only',
            'platform-suspended',
        ]));
        expect(supervisor.listTunnels().platformLimitations.find((limitation) => limitation.reason === 'platform-suspended')?.message)
            .toBe('settings.accessEndpoints.limitation.platform-suspended');
        expect(supervisor.listTunnels().leases[0]?.status).toBe('degraded');
    });

    /**
     * §7.1 deciding check. An authentication failure aborts before any lease exists, so the whole
     * chain — supervisor limitation → snapshot → projection diagnostics → access channel — has to
     * carry it without an endpoint. Only the native adapter (a real system boundary) is faked.
     */
    it('surfaces an authentication failure all the way to an access channel with no lease', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const authError = Object.assign(new Error('native_ssh_auth'), { code: 'authentication-failed' });
        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => {
                throw authError;
            }),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({ ok: true as const })),
        });

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toBe(authError);

        const snapshot = supervisor.listTunnels();
        expect(snapshot.leases).toEqual([]);

        const projection = buildAccessEndpointProjection({
            clientContext: 'native',
            nativeSshTunnelSnapshot: snapshot,
        });
        expect(projection.endpoints).toEqual([]);
        expect(projection.diagnostics.map((diagnostic) => diagnostic.id))
            .toContain('native-ssh.authentication-failed');

        const channels = buildAccessChannelProjection({
            endpoints: projection.endpoints,
            diagnostics: projection.diagnostics,
        });
        expect(channels.map((channel) => channel.kind)).toEqual(['ssh-tunnel-native']);
        expect(channels[0]?.limitations).toContainEqual(expect.objectContaining({
            reason: 'authentication-failed',
            severity: 'error',
        }));
    });

    it('rejects direct supervisor tunnel starts while suspended', async () => {
        const loaded = await import('./supervisor').catch(() => null);
        expect(loaded).not.toBeNull();

        const adapter: NativeSshTunnelAdapter = {
            startLoopbackTunnel: vi.fn(async () => ({ nativeTunnelId: 'native-1', localPort: 49152 })),
            stopLoopbackTunnel: vi.fn(async () => undefined),
        };
        const supervisor = loaded!.createNativeSshTunnelSupervisor({
            adapter,
            probe: vi.fn(async () => ({ ok: true as const })),
        });

        supervisor.markSuspended();

        await expect(supervisor.ensureTunnel(createRequest())).rejects.toThrow('native_ssh_tunnel_suspended');
        expect(adapter.startLoopbackTunnel).not.toHaveBeenCalled();
    });
});
