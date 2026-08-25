import { describe, expect, it } from 'vitest';

describe('native SSH tunnel AccessEndpoint source', () => {
    it('emits device-local native SSH tunnel endpoints with explicit native source classification', async () => {
        const loaded = await import('./nativeSshTunnelSource').catch(() => null);
        expect(loaded).not.toBeNull();

        const endpoints = loaded!.buildNativeSshTunnelAccessEndpoints({
            snapshot: {
                leases: [{
                    leaseId: 'lease-a',
                    key: 'key-a',
                    remoteHostId: 'host-a',
                    localUrl: 'http://127.0.0.1:49152',
                    channelMode: 'loopback-port',
                    purpose: 'server-http',
                    status: 'ready',
                    startedAt: '2026-05-06T10:00:00.000Z',
                }],
                platformLimitations: [{
                    id: 'foreground-only',
                    severity: 'info',
                    reason: 'foreground-only',
                    message: 'accessEndpoints.nativeSsh.foregroundOnly',
                }],
            },
        });

        expect(endpoints).toEqual([
            expect.objectContaining({
                id: 'ssh-tunnel-native:host-a:key-a',
                remoteHostId: 'host-a',
                source: 'ssh-tunnel-native',
                reachability: 'loopback',
                hostedHttpsCompatibility: 'not-applicable',
                durability: 'session',
                status: 'available',
                httpBaseUrl: 'http://127.0.0.1:49152',
                label: 'settings.accessEndpoints.kind.ssh-tunnel-native',
            }),
        ]);
        // Runtime limitations belong to the projection, not to a lease-derived endpoint: they
        // exist (and matter most) when there is no lease at all.
        expect(endpoints[0]?.diagnostics?.map((diagnostic) => diagnostic.id))
            .toEqual(['ssh-tunnel.native.this-device-only']);
        expect(endpoints[0]?.remediationActions).toEqual([{
            id: 'ssh-tunnel-native:lease-a:stop',
            label: 'sshTunnel.stop',
            ownerSurface: 'sshTunnel.stop',
            payload: {
                leaseId: 'lease-a',
                tunnelKey: 'key-a',
            },
        }]);
    });

    it('rejects malformed non-loopback native tunnel snapshot URLs', async () => {
        const loaded = await import('./nativeSshTunnelSource').catch(() => null);
        expect(loaded).not.toBeNull();

        const endpoints = loaded!.buildNativeSshTunnelAccessEndpoints({
            snapshot: {
                leases: [{
                    leaseId: 'lease-a',
                    key: 'key-a',
                    remoteHostId: 'host-a',
                    localUrl: 'http://192.0.2.10:49152',
                    channelMode: 'loopback-port',
                    purpose: 'server-http',
                    status: 'ready',
                    startedAt: '2026-05-06T10:00:00.000Z',
                }],
                platformLimitations: [],
            },
        });

        expect(endpoints).toEqual([]);
    });

    it('does not project non-http native tunnel purposes as server HTTP endpoints', async () => {
        const loaded = await import('./nativeSshTunnelSource').catch(() => null);
        expect(loaded).not.toBeNull();

        const endpoints = loaded!.buildNativeSshTunnelAccessEndpoints({
            snapshot: {
                leases: [{
                    leaseId: 'lease-ws',
                    key: 'key-ws',
                    remoteHostId: 'host-a',
                    localUrl: 'http://127.0.0.1:49153',
                    channelMode: 'loopback-port',
                    purpose: 'server-websocket',
                    status: 'ready',
                    startedAt: '2026-05-06T10:00:00.000Z',
                }, {
                    leaseId: 'lease-relay',
                    key: 'key-relay',
                    remoteHostId: 'host-a',
                    localUrl: 'http://127.0.0.1:49154',
                    channelMode: 'loopback-port',
                    purpose: 'relay-runtime',
                    status: 'ready',
                    startedAt: '2026-05-06T10:00:00.000Z',
                }],
                platformLimitations: [],
            },
        });

        expect(endpoints).toEqual([]);
    });

    it('keeps failed native tunnel endpoints visible so retained native handles can be stopped', async () => {
        const loaded = await import('./nativeSshTunnelSource').catch(() => null);
        expect(loaded).not.toBeNull();

        const endpoints = loaded!.buildNativeSshTunnelAccessEndpoints({
            snapshot: {
                leases: [{
                    leaseId: 'lease-failed',
                    key: 'key-failed',
                    remoteHostId: 'host-a',
                    localUrl: 'http://127.0.0.1:49152',
                    channelMode: 'loopback-port',
                    purpose: 'server-http',
                    status: 'failed',
                    startedAt: '2026-05-06T10:00:00.000Z',
                }],
                platformLimitations: [],
            },
        });

        expect(endpoints).toEqual([
            expect.objectContaining({
                id: 'ssh-tunnel-native:host-a:key-failed',
                status: 'unavailable',
                remediationActions: [{
                    id: 'ssh-tunnel-native:lease-failed:stop',
                    label: 'sshTunnel.stop',
                    ownerSurface: 'sshTunnel.stop',
                    payload: {
                        leaseId: 'lease-failed',
                        tunnelKey: 'key-failed',
                    },
                }],
            }),
        ]);
    });
});
