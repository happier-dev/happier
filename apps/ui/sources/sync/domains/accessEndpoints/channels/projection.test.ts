import { describe, expect, it } from 'vitest';

import type { AccessEndpoint } from '../model';

function endpoint(overrides: Partial<AccessEndpoint>): AccessEndpoint {
    return {
        id: 'endpoint-a',
        label: 'Endpoint A',
        source: 'relay-access',
        reachability: 'public',
        hostedHttpsCompatibility: 'compatible',
        durability: 'persistent',
        status: 'available',
        httpBaseUrl: 'https://example.test',
        ...overrides,
    };
}

describe('access channel projection', () => {
    it('keeps outward relay access separate from device-local SSH tunnel channels', async () => {
        const loaded = await import('./buildProjection').catch(() => null);
        expect(loaded).not.toBeNull();

        const channels = loaded!.buildAccessChannelProjection({
            endpoints: [
                endpoint({
                    id: 'relay-access:tailscaleFunnel',
                    source: 'relay-access',
                    providerId: 'tailscaleFunnel',
                    label: 'Tailscale Funnel',
                }),
                endpoint({
                    id: 'ssh-tunnel-native:key-a',
                    source: 'ssh-tunnel-native',
                    label: 'Phone SSH tunnel',
                    reachability: 'loopback',
                    hostedHttpsCompatibility: 'not-applicable',
                    durability: 'session',
                    httpBaseUrl: 'http://127.0.0.1:49152',
                }),
            ],
        });

        expect(channels.map((channel) => [channel.kind, channel.direction])).toEqual([
            ['relay-access-provider', 'make-current-server-reachable'],
            ['ssh-tunnel-native', 'reach-remote-server-from-this-device'],
        ]);
        expect(channels.find((channel) => channel.kind === 'ssh-tunnel-native')?.limitations.map((limitation) => limitation.reason)).toEqual(expect.arrayContaining([
            'this-device-only',
            'not-hosted-web-compatible',
            'not-public-share-url',
            'session-scoped',
        ]));
    });

    it('classifies desktop SSH tunnels as this-device diagnostic channels instead of multi-device access', async () => {
        const loaded = await import('./buildProjection').catch(() => null);
        expect(loaded).not.toBeNull();

        const channels = loaded!.buildAccessChannelProjection({
            endpoints: [
                endpoint({
                    id: 'ssh-tunnel:desktop-key-a',
                    source: 'ssh-tunnel-desktop',
                    label: 'Desktop SSH tunnel',
                    reachability: 'loopback',
                    hostedHttpsCompatibility: 'not-applicable',
                    durability: 'session',
                    httpBaseUrl: 'http://127.0.0.1:49152',
                }),
            ],
        });

        expect(channels[0]?.recommendedUse).toBe('diagnostic');
        expect(channels[0]?.limitations.map((limitation) => limitation.reason)).toEqual(expect.arrayContaining([
            'this-device-only',
            'not-public-share-url',
            'session-scoped',
        ]));
    });

    it('surfaces native platform suspension as an access-channel limitation', async () => {
        const loaded = await import('./buildProjection').catch(() => null);
        expect(loaded).not.toBeNull();

        const channels = loaded!.buildAccessChannelProjection({
            endpoints: [
                endpoint({
                    id: 'ssh-tunnel-native:key-a',
                    source: 'ssh-tunnel-native',
                    label: 'Phone SSH tunnel',
                    reachability: 'loopback',
                    hostedHttpsCompatibility: 'not-applicable',
                    durability: 'session',
                    httpBaseUrl: 'http://127.0.0.1:49152',
                }),
            ],
            diagnostics: [{
                id: 'native-ssh.platform-suspended',
                severity: 'warning',
                message: 'settings.accessEndpoints.limitation.platform-suspended',
            }],
        });

        expect(channels[0]?.limitations).toContainEqual(expect.objectContaining({
            severity: 'warning',
            reason: 'platform-suspended',
        }));
    });

    it('surfaces native tunnel transport diagnostics as access-channel limitations', async () => {
        const loaded = await import('./buildProjection').catch(() => null);
        expect(loaded).not.toBeNull();

        const channels = loaded!.buildAccessChannelProjection({
            endpoints: [
                endpoint({
                    id: 'ssh-tunnel-native:key-a',
                    source: 'ssh-tunnel-native',
                    label: 'Phone SSH tunnel',
                    reachability: 'loopback',
                    hostedHttpsCompatibility: 'not-applicable',
                    durability: 'session',
                    httpBaseUrl: 'http://127.0.0.1:49152',
                }),
            ],
            diagnostics: [
                {
                    id: 'native-ssh.authentication-failed',
                    severity: 'error',
                    message: 'settings.accessEndpoints.limitation.authentication-failed',
                },
                {
                    id: 'native-ssh.host-key-untrusted',
                    severity: 'warning',
                    message: 'settings.accessEndpoints.limitation.host-key-untrusted',
                },
                {
                    id: 'native-ssh.host-key-rejected',
                    severity: 'error',
                    message: 'settings.accessEndpoints.limitation.host-key-rejected',
                },
                {
                    id: 'native-ssh.host-key-mismatch',
                    severity: 'error',
                    message: 'settings.accessEndpoints.limitation.host-key-mismatch',
                },
                {
                    id: 'native-ssh.remote-service-unreachable',
                    severity: 'error',
                    message: 'settings.accessEndpoints.limitation.remote-service-unreachable',
                },
                {
                    id: 'native-ssh.loopback-bind-failed',
                    severity: 'error',
                    message: 'settings.accessEndpoints.limitation.loopback-bind-failed',
                },
                {
                    id: 'native-ssh.network-captive-portal',
                    severity: 'error',
                    message: 'settings.accessEndpoints.limitation.network-captive-portal',
                },
            ],
        });

        expect(channels[0]?.limitations).toEqual(expect.arrayContaining([
            expect.objectContaining({ reason: 'authentication-failed', severity: 'error' }),
            expect.objectContaining({ reason: 'host-key-untrusted', severity: 'warning' }),
            expect.objectContaining({ reason: 'host-key-rejected', severity: 'error' }),
            expect.objectContaining({ reason: 'host-key-mismatch', severity: 'error' }),
            expect.objectContaining({ reason: 'remote-service-unreachable', severity: 'error' }),
            expect.objectContaining({ reason: 'loopback-bind-failed', severity: 'error' }),
            expect.objectContaining({ reason: 'network-captive-portal', severity: 'error' }),
        ]));
    });

    /**
     * §7.1: an SSH auth or host-key failure aborts before a lease exists, so there is no endpoint
     * to hang the limitation on. Without an endpoint-less channel the user is told nothing at all.
     */
    it('surfaces a native SSH failure as its own channel when no lease produced an endpoint', async () => {
        const loaded = await import('./buildProjection').catch(() => null);
        expect(loaded).not.toBeNull();

        const channels = loaded!.buildAccessChannelProjection({
            endpoints: [],
            diagnostics: [
                {
                    id: 'native-ssh.foreground-only',
                    severity: 'info',
                    message: 'settings.accessEndpoints.limitation.foreground-only',
                },
                {
                    id: 'native-ssh.authentication-failed',
                    severity: 'error',
                    message: 'settings.accessEndpoints.limitation.authentication-failed',
                },
            ],
        });

        expect(channels).toHaveLength(1);
        expect(channels[0]?.kind).toBe('ssh-tunnel-native');
        expect(channels[0]?.endpointIds).toEqual([]);
        expect(channels[0]?.limitations).toContainEqual(expect.objectContaining({
            reason: 'authentication-failed',
            severity: 'error',
        }));
    });

    it('does not invent a native channel from ambient informational notes alone', async () => {
        const loaded = await import('./buildProjection').catch(() => null);
        expect(loaded).not.toBeNull();

        const channels = loaded!.buildAccessChannelProjection({
            endpoints: [],
            diagnostics: [{
                id: 'native-ssh.foreground-only',
                severity: 'info',
                message: 'settings.accessEndpoints.limitation.foreground-only',
            }],
        });

        expect(channels).toEqual([]);
    });

    it('maps hyphenated direction ids to stable translation keys', async () => {
        const { buildAccessChannelCopyKeys } = await import('./copy');

        const keys = buildAccessChannelCopyKeys({
            id: 'access-channel:ssh-tunnel-native:lease-a',
            label: 'Phone SSH tunnel',
            direction: 'reach-remote-server-from-this-device',
            kind: 'ssh-tunnel-native',
            endpointIds: ['ssh-tunnel-native:lease-a'],
            recommendedUse: 'native-this-device',
            limitations: [],
            remediationActionIds: [],
        });

        expect(keys).toEqual({
            titleKey: 'settings.accessEndpoints.kind.ssh-tunnel-native',
            subtitleKey: 'settings.accessEndpoints.direction.reachRemoteServerFromThisDevice',
        });
    });
});
