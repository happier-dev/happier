import { describe, expect, it } from 'vitest';

type Endpoint = Readonly<{
    id: string;
    label: string;
    source: string;
    providerId?: string;
    reachability: string;
    hostedHttpsCompatibility: string;
    durability: string;
    status: string;
    httpBaseUrl: string;
    wsBaseUrl?: string;
    diagnostics?: readonly Readonly<{ id: string; severity: string }>[];
    remediationActions?: readonly Readonly<{ id: string; ownerSurface: string }>[];
}>;

type Projection = Readonly<{
    endpoints: readonly Endpoint[];
    remediationActions: readonly Readonly<{ id: string; ownerSurface: string; payload?: Readonly<Record<string, unknown>> }>[];
    diagnostics: readonly Readonly<{ id: string; severity: string; message: string }>[];
}>;

type ClassifierModule = Readonly<{
    classifyAccessEndpointReachability: (httpBaseUrl: string) => string;
    classifyAccessEndpointHostedHttpsCompatibility: (params: Readonly<{
        httpBaseUrl: string;
        clientContext: string;
    }>) => string;
    deriveAccessEndpointWsBaseUrl: (httpBaseUrl: string) => string | null;
}>;

type ProjectionModule = Readonly<{
    buildAccessEndpointProjection: (params: Readonly<{
        clientContext?: string;
        serverProfiles?: readonly Readonly<{
            id: string;
            name: string;
            serverUrl: string;
            shareableServerUrl?: string | null;
            shareableServerUrlValidatedAgainstServerUrl?: string | null;
        }>[];
        relayAccess?: readonly Readonly<{
            config: Readonly<Record<string, unknown>>;
            status: Readonly<{ state: string; shareUrl?: string; details?: unknown }>;
        }>[];
        localRuntimeCandidates?: readonly Readonly<{
            url: string;
            source: string;
            label: string;
            detail: string | null;
            verified: boolean;
        }>[];
        remoteHosts?: readonly Readonly<{
            id: string;
            name: string;
            ssh: Readonly<{ target: string; authMode: string; port?: number | null }>;
        }>[];
        sshTunnelSnapshots?: readonly Readonly<{
            tunnelKey: string;
            httpBaseUrl: string;
            wsBaseUrl?: string;
            localPort: number;
            remoteHost: string;
            remotePort: number;
            purpose: string;
            remoteHostId?: string;
            status: string;
            leaseCount: number;
            createdAt: string;
            lastProbeAt: string | null;
        }>[];
        nativeSshTunnelSnapshot?: Readonly<{
            leases: readonly Readonly<{
                leaseId: string;
                key: string;
                remoteHostId: string;
                localUrl?: string;
                channelMode: 'loopback-port';
                purpose: string;
                status: string;
                startedAt: string;
            }>[];
            platformLimitations: readonly Readonly<{
                id: string;
                severity: string;
                reason: string;
                message: string;
            }>[];
        }>;
    }>) => Projection;
    sortAccessEndpoints: (endpoints: readonly Endpoint[], clientContext?: string) => readonly Endpoint[];
}>;

async function loadClassifierModule(): Promise<ClassifierModule> {
    const loaded = await import('./classify').catch(() => null);
    expect(loaded).not.toBeNull();
    expect(typeof loaded?.classifyAccessEndpointReachability).toBe('function');
    expect(typeof loaded?.classifyAccessEndpointHostedHttpsCompatibility).toBe('function');
    expect(typeof loaded?.deriveAccessEndpointWsBaseUrl).toBe('function');
    return loaded as ClassifierModule;
}

async function loadProjectionModule(): Promise<ProjectionModule> {
    const loaded = await import('./buildProjection').catch(() => null);
    expect(loaded).not.toBeNull();
    expect(typeof loaded?.buildAccessEndpointProjection).toBe('function');
    expect(typeof loaded?.sortAccessEndpoints).toBe('function');
    return loaded as ProjectionModule;
}

describe('AccessEndpoint projection', () => {
    it('classifies raw reachability separately from hosted HTTPS compatibility', async () => {
        const classifier = await loadClassifierModule();

        expect(classifier.classifyAccessEndpointReachability('http://127.0.0.1:3005')).toBe('loopback');
        expect(classifier.classifyAccessEndpointReachability('http://192.168.1.42:3005')).toBe('lan');
        expect(classifier.classifyAccessEndpointReachability('https://team.tailnet.ts.net')).toBe('private-network');
        expect(classifier.classifyAccessEndpointReachability('https://api.example.test')).toBe('public');

        expect(classifier.classifyAccessEndpointHostedHttpsCompatibility({
            httpBaseUrl: 'http://127.0.0.1:3005',
            clientContext: 'hosted-https-web',
        })).toBe('mixed-content-blocked');
        expect(classifier.classifyAccessEndpointHostedHttpsCompatibility({
            httpBaseUrl: 'http://127.0.0.1:3005',
            clientContext: 'desktop',
        })).toBe('not-applicable');
        expect(classifier.classifyAccessEndpointHostedHttpsCompatibility({
            httpBaseUrl: 'https://api.example.test',
            clientContext: 'hosted-https-web',
        })).toBe('compatible');
        expect(classifier.deriveAccessEndpointWsBaseUrl('https://api.example.test')).toBe('wss://api.example.test');
    });

    it('derives canonical and shareable server profile endpoints without mutating profiles', async () => {
        const projectionModule = await loadProjectionModule();
        const profile = {
            id: 'local-dev',
            name: 'Local dev',
            serverUrl: 'http://127.0.0.1:3005',
            shareableServerUrl: 'https://share.example.test/path?token=secret',
            shareableServerUrlValidatedAgainstServerUrl: 'http://127.0.0.1:3005/',
        };

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'hosted-https-web',
            serverProfiles: [profile],
        });

        expect(profile.shareableServerUrl).toBe('https://share.example.test/path?token=secret');
        expect(projection.endpoints.map((endpoint) => endpoint.id)).toEqual([
            'server-profile:local-dev:shareable',
            'server-profile:local-dev:canonical',
        ]);
        expect(projection.endpoints[0]).toMatchObject({
            source: 'server-profile',
            reachability: 'public',
            hostedHttpsCompatibility: 'compatible',
            status: 'available',
            httpBaseUrl: 'https://share.example.test/path',
            wsBaseUrl: 'wss://share.example.test/path',
        });
        expect(projection.endpoints[1]).toMatchObject({
            source: 'server-profile',
            reachability: 'loopback',
            hostedHttpsCompatibility: 'mixed-content-blocked',
            status: 'available',
            httpBaseUrl: 'http://127.0.0.1:3005',
            wsBaseUrl: 'ws://127.0.0.1:3005',
        });
    });

    it('marks stale shareable server profile URLs as repairable projection data', async () => {
        const projectionModule = await loadProjectionModule();

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'hosted-https-web',
            serverProfiles: [{
                id: 'server-a',
                name: 'Server A',
                serverUrl: 'http://10.1.2.3:3005',
                shareableServerUrl: 'https://old.example.test',
                shareableServerUrlValidatedAgainstServerUrl: 'http://10.9.9.9:3005',
            }],
        });

        const shareable = projection.endpoints.find((endpoint) => endpoint.id === 'server-profile:server-a:shareable');
        expect(shareable).toMatchObject({
            status: 'requires-configuration',
            httpBaseUrl: 'https://old.example.test',
            remediationActions: [{
                ownerSurface: 'serverProfile.configureShareableUrl',
            }],
        });
        expect(shareable?.diagnostics?.map((diagnostic) => diagnostic.id)).toEqual(['server-profile.shareable-url.stale-validation']);
    });

    it('maps relay access statuses through provider descriptors and remediation owners', async () => {
        const projectionModule = await loadProjectionModule();

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'hosted-https-web',
            relayAccess: [
                {
                    config: { providerId: 'lan', url: 'http://192.168.1.44:3005' },
                    status: { state: 'enabled', shareUrl: 'http://192.168.1.44:3005/' },
                },
                {
                    config: { providerId: 'tailscaleFunnel' },
                    status: {
                        state: 'needs_auth',
                        shareUrl: 'https://funnel.tailnet.ts.net',
                        details: { reason: 'tailscale_funnel_approval_required' },
                    },
                },
                {
                    config: { providerId: 'cloudflareNamed', hostname: 'team.example.test', token: 'secret' },
                    status: {
                        state: 'error',
                        shareUrl: 'https://team.example.test',
                        details: { reason: 'missing_token' },
                    },
                },
            ],
        });

        expect(projection.endpoints.map((endpoint) => [endpoint.id, endpoint.status, endpoint.reachability])).toEqual([
            ['relay-access:lan', 'available', 'lan'],
            ['relay-access:tailscaleFunnel', 'needs-auth', 'public'],
            ['relay-access:cloudflareNamed', 'unavailable', 'public'],
        ]);
        expect(projection.endpoints.find((endpoint) => endpoint.providerId === 'lan')).toMatchObject({
            hostedHttpsCompatibility: 'mixed-content-blocked',
            durability: 'persistent',
        });
        expect(projection.endpoints.find((endpoint) => endpoint.providerId === 'tailscaleFunnel')?.remediationActions).toEqual([{
            id: 'tailscale.funnel.approve',
            label: 'tailscale.funnel.approve',
            ownerSurface: 'tailscale.funnel.approve',
        }]);
        expect(projection.endpoints.find((endpoint) => endpoint.providerId === 'cloudflareNamed')?.remediationActions).toEqual([{
            id: 'cloudflare.configure',
            label: 'cloudflare.configure',
            ownerSurface: 'cloudflare.configure',
        }]);
    });

    it('keeps relay candidates repairable when enabled statuses lack a valid public URL', async () => {
        const projectionModule = await loadProjectionModule();

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'hosted-https-web',
            relayAccess: [
                {
                    config: { providerId: 'tailscaleServe' },
                    status: {
                        state: 'enabled',
                        details: { reason: 'tailscale_not_installed' },
                    },
                },
                {
                    config: { providerId: 'cloudflareNamed', hostname: 'fallback.example.test', token: 'secret' },
                    status: { state: 'enabled' },
                },
                {
                    config: { providerId: 'lan', url: 'lan.example.test' },
                    status: { state: 'enabled', shareUrl: 'lan.example.test' },
                },
            ],
        });

        expect(projection.endpoints.map((endpoint) => [endpoint.id, endpoint.status, endpoint.httpBaseUrl])).toEqual([
            ['relay-access:cloudflareNamed', 'requires-configuration', ''],
            ['relay-access:tailscaleServe', 'requires-configuration', ''],
            ['relay-access:lan', 'requires-configuration', ''],
        ]);
        expect(projection.endpoints.find((endpoint) => endpoint.providerId === 'lan')?.wsBaseUrl).toBeUndefined();
        expect(projection.endpoints.find((endpoint) => endpoint.providerId === 'tailscaleServe')?.remediationActions).toEqual([{
            id: 'tailscale.install',
            label: 'tailscale.install',
            ownerSurface: 'tailscale.install',
        }]);
        expect(projection.endpoints.flatMap((endpoint) => endpoint.diagnostics?.map((diagnostic) => diagnostic.id) ?? [])).toContain(
            'relay-access.share-url.missing-or-invalid',
        );
    });

    it('projects local runtime candidates and remote-host repair descriptors without emitting ssh tunnel endpoints', async () => {
        const projectionModule = await loadProjectionModule();

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'hosted-https-web',
            localRuntimeCandidates: [
                {
                    url: 'https://host.tailnet.ts.net',
                    source: 'tailscale-serve',
                    label: 'Tailscale Serve (HTTPS)',
                    detail: null,
                    verified: true,
                },
                {
                    url: 'http://100.84.12.8:3005',
                    source: 'tailscale-ip',
                    label: 'Tailscale IP',
                    detail: 'tailscale0',
                    verified: true,
                },
            ],
            remoteHosts: [{
                id: 'remote-1',
                name: 'Build box',
                ssh: { target: 'builder.example.test', authMode: 'agent' },
            }],
        });

        expect(projection.endpoints.map((endpoint) => endpoint.id)).toEqual([
            'local-runtime:tailscale-serve:https://host.tailnet.ts.net',
            'local-runtime:tailscale-ip:http://100.84.12.8:3005',
        ]);
        expect(projection.endpoints.map((endpoint) => endpoint.source)).not.toContain('ssh-tunnel-desktop');
        expect(projection.endpoints[0]).toMatchObject({
            source: 'local-runtime',
            reachability: 'private-network',
            hostedHttpsCompatibility: 'compatible',
            status: 'available',
            durability: 'session',
        });
        expect(projection.endpoints[1]).toMatchObject({
            source: 'local-runtime',
            reachability: 'private-network',
            hostedHttpsCompatibility: 'mixed-content-blocked',
        });
        expect(projection.remediationActions).toEqual([
            {
                id: 'remoteHost.add',
                label: 'remoteHost.add',
                ownerSurface: 'remoteHost.add',
            },
            {
                id: 'remote-host:remote-1:setup',
                label: 'remoteHost.setup',
                ownerSurface: 'remoteHost.setup',
                payload: {
                    remoteHostId: 'remote-1',
                },
            },
        ]);
    });

    it('projects supervised SSH tunnel snapshots as local-only session access endpoints', async () => {
        const projectionModule = await loadProjectionModule();

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'hosted-https-web',
            sshTunnelSnapshots: [
                {
                    tunnelKey: 'ssh-tunnel:host-a',
                    httpBaseUrl: 'http://127.0.0.1:49152',
                    wsBaseUrl: 'ws://127.0.0.1:49152',
                    localPort: 49152,
                    remoteHost: '127.0.0.1',
                    remotePort: 3005,
                    purpose: 'remote-host-access',
                    remoteHostId: 'host-a',
                    status: 'available',
                    leaseCount: 1,
                    createdAt: '2026-05-06T10:00:00.000Z',
                    lastProbeAt: '2026-05-06T10:01:00.000Z',
                },
                {
                    tunnelKey: 'ssh-tunnel:needs-auth',
                    httpBaseUrl: 'http://127.0.0.1:49153',
                    localPort: 49153,
                    remoteHost: '127.0.0.1',
                    remotePort: 3005,
                    purpose: 'remote-host-access',
                    status: 'needs-auth',
                    leaseCount: 0,
                    createdAt: '2026-05-06T10:00:00.000Z',
                    lastProbeAt: null,
                },
            ],
        });

        expect(projection.endpoints.map((endpoint) => endpoint.id)).toEqual([
            'ssh-tunnel:ssh-tunnel:host-a',
            'ssh-tunnel:ssh-tunnel:needs-auth',
        ]);
        expect(projection.endpoints[0]).toMatchObject({
            source: 'ssh-tunnel-desktop',
            reachability: 'loopback',
            hostedHttpsCompatibility: 'not-applicable',
            durability: 'session',
            status: 'available',
            httpBaseUrl: 'http://127.0.0.1:49152',
            wsBaseUrl: 'ws://127.0.0.1:49152',
        });
        expect(projection.endpoints[0].providerId).toBeUndefined();
        expect(projection.endpoints[0].diagnostics?.map((diagnostic) => diagnostic.id)).toContain('ssh-tunnel.local-device-only');
        expect(projection.endpoints[0].remediationActions?.map((action) => action.ownerSurface)).toEqual([
            'sshTunnel.stop',
        ]);
        expect(projection.endpoints[1]).toMatchObject({
            source: 'ssh-tunnel-desktop',
            hostedHttpsCompatibility: 'not-applicable',
            status: 'needs-auth',
        });
        expect(projection.endpoints[1].remediationActions).toEqual([]);
    });

    it('projects native SSH tunnel snapshots as this-device access endpoints', async () => {
        const projectionModule = await loadProjectionModule();

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'native',
            nativeSshTunnelSnapshot: {
                leases: [{
                    leaseId: 'native-lease-1',
                    key: 'native-key-a',
                    remoteHostId: 'host-a',
                    localUrl: 'http://127.0.0.1:49154',
                    channelMode: 'loopback-port',
                    purpose: 'server-http',
                    status: 'ready',
                    startedAt: '2026-05-06T10:00:00.000Z',
                }],
                platformLimitations: [],
            },
        });

        expect(projection.endpoints).toEqual([
            expect.objectContaining({
                id: 'ssh-tunnel-native:host-a:native-key-a',
                remoteHostId: 'host-a',
                source: 'ssh-tunnel-native',
                reachability: 'loopback',
                hostedHttpsCompatibility: 'not-applicable',
                durability: 'session',
                status: 'available',
                httpBaseUrl: 'http://127.0.0.1:49154',
                wsBaseUrl: 'ws://127.0.0.1:49154',
            }),
        ]);
        expect(projection.endpoints[0]?.remediationActions).toEqual([{
            id: 'ssh-tunnel-native:native-lease-1:stop',
            label: 'sshTunnel.stop',
            ownerSurface: 'sshTunnel.stop',
            payload: {
                leaseId: 'native-lease-1',
                tunnelKey: 'native-key-a',
            },
        }]);
        expect(projection.remediationActions).toContainEqual(expect.objectContaining({
            id: 'ssh-tunnel-native:native-lease-1:stop',
            ownerSurface: 'sshTunnel.stop',
        }));
    });

    it('sorts projection output for hosted HTTPS consumers', async () => {
        const projectionModule = await loadProjectionModule();

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'hosted-https-web',
            serverProfiles: [{
                id: 'local-dev',
                name: 'Local dev',
                serverUrl: 'http://127.0.0.1:3005',
            }],
            relayAccess: [{
                config: { providerId: 'cloudflareNamed', hostname: 'team.example.test', token: 'secret' },
                status: { state: 'enabled', shareUrl: 'https://team.example.test' },
            }],
        });

        expect(projection.endpoints.map((endpoint) => endpoint.id)).toEqual([
            'relay-access:cloudflareNamed',
            'server-profile:local-dev:canonical',
        ]);
    });

    it('orders endpoints by client context without treating reachability as hosted compatibility', async () => {
        const projectionModule = await loadProjectionModule();
        const endpoints: readonly Endpoint[] = [
            {
                id: 'loopback',
                label: 'Loopback',
                source: 'server-profile',
                reachability: 'loopback',
                hostedHttpsCompatibility: 'mixed-content-blocked',
                durability: 'persistent',
                status: 'available',
                httpBaseUrl: 'http://127.0.0.1:3005',
            },
            {
                id: 'cloudflare',
                label: 'Cloudflare',
                source: 'relay-access',
                reachability: 'public',
                hostedHttpsCompatibility: 'compatible',
                durability: 'persistent',
                status: 'available',
                httpBaseUrl: 'https://team.example.test',
            },
        ];

        expect(projectionModule.sortAccessEndpoints(endpoints, 'hosted-https-web').map((endpoint) => endpoint.id)).toEqual([
            'cloudflare',
            'loopback',
        ]);
        expect(projectionModule.sortAccessEndpoints(endpoints, 'desktop').map((endpoint) => endpoint.id)).toEqual([
            'loopback',
            'cloudflare',
        ]);
    });

    /**
     * §7.1: on auth or host-key failure the native supervisor records a runtime limitation but
     * never calls `store.put`, so there is no lease. Limitations that only travel nested inside a
     * lease-derived endpoint are therefore dropped in the primary failure case. They belong to the
     * projection, not to an endpoint.
     */
    it('surfaces native SSH platform limitations at projection level when no lease exists', async () => {
        const projectionModule = await loadProjectionModule();

        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'native',
            nativeSshTunnelSnapshot: {
                leases: [],
                platformLimitations: [
                    {
                        id: 'native-ssh.foreground-only',
                        severity: 'info',
                        reason: 'foreground-only',
                        message: 'settings.accessEndpoints.limitation.foreground-only',
                    },
                    {
                        id: 'native-ssh.authentication-failed',
                        severity: 'error',
                        reason: 'authentication-failed',
                        message: 'settings.accessEndpoints.limitation.authentication-failed',
                    },
                ],
            },
        });

        expect(projection.endpoints).toEqual([]);
        expect(projection.diagnostics).toEqual([
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
        ]);
    });

    it('emits the platform limitations once at projection level rather than per lease', async () => {
        const projectionModule = await loadProjectionModule();

        const lease = (suffix: string, port: number) => ({
            leaseId: `native-lease-${suffix}`,
            key: `native-key-${suffix}`,
            remoteHostId: 'host-a',
            localUrl: `http://127.0.0.1:${port}`,
            channelMode: 'loopback-port' as const,
            purpose: 'server-http',
            status: 'ready',
            startedAt: '2026-05-06T10:00:00.000Z',
        });
        const projection = projectionModule.buildAccessEndpointProjection({
            clientContext: 'native',
            nativeSshTunnelSnapshot: {
                leases: [lease('a', 49154), lease('b', 49155)],
                platformLimitations: [{
                    id: 'native-ssh.host-key-untrusted',
                    severity: 'error',
                    reason: 'host-key-untrusted',
                    message: 'settings.accessEndpoints.limitation.host-key-untrusted',
                }],
            },
        });

        expect(projection.endpoints).toHaveLength(2);
        expect(projection.diagnostics.filter((entry) => entry.id === 'native-ssh.host-key-untrusted'))
            .toHaveLength(1);
        for (const endpoint of projection.endpoints) {
            expect((endpoint.diagnostics ?? []).map((entry) => entry.id))
                .toEqual(['ssh-tunnel.native.this-device-only']);
        }
    });
});
