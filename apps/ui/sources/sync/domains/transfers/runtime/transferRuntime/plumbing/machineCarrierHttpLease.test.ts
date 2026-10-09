import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    acquireBrowserMachineCarrierHttpLease,
    acquireMachineCarrierHttpLease,
    resolveMachineCarrierRoute,
} from './machineCarrierHttpLease';

const boundaries = vi.hoisted(() => {
    const focus = { activeServerId: 'server-1' };
    const serverUrls: Record<string, string> = {
        'server-1': 'https://server.example.test',
        'server-2': 'https://server-b.example.test',
    };
    const endpointsByServerId: Record<string, {
        endpointId: string;
        directAddresses: string[];
        relayUrls: string[];
    }> = {};
    const finiteTransferRpcEligibleServerIds = new Set<string>();
    const identityOnlyEndpointServerIds = new Set<string>();
    const currentTransferSupportedServerIds = new Set<string>();
    const resetEndpoints = () => {
        finiteTransferRpcEligibleServerIds.clear();
        identityOnlyEndpointServerIds.clear();
        currentTransferSupportedServerIds.clear();
        currentTransferSupportedServerIds.add('server-1');
        currentTransferSupportedServerIds.add('server-2');
        endpointsByServerId['server-1'] = {
            endpointId: 'a'.repeat(64),
            directAddresses: ['127.0.0.1:48123'],
            relayUrls: ['https://relay.example.test'],
        };
        endpointsByServerId['server-2'] = {
            endpointId: 'c'.repeat(64),
            directAddresses: ['127.0.0.1:48125'],
            relayUrls: ['https://relay-b.example.test'],
        };
    };
    resetEndpoints();
    return {
        browserHostEligible: vi.fn(() => false),
        resolvePackagedClient: vi.fn(),
        createBrowserBinding: vi.fn(),
        createBrowserHttpConnection: vi.fn(),
        acquireBrowserStream: vi.fn(),
        getReadyServerFeatures: vi.fn(async (..._args: unknown[]) => ({
            features: {
                machines: {
                    transfer: { enabled: true, directPeer: { enabled: true } },
                    peerMediation: { enabled: true },
                },
            },
        })),
        getCredentials: vi.fn(),
        requestGrant: vi.fn(),
        probeNative: vi.fn(async () => true),
        startTunnel: vi.fn(),
        captureAuthority: vi.fn(),
        releaseAuthority: vi.fn(),
        resolveTargetServer: vi.fn((requestedServerId?: string | null) => {
            // Mirrors productionRouteHttp: an explicit id wins, otherwise the
            // currently focused home is resolved.
            const requested = typeof requestedServerId === 'string' && requestedServerId.trim().length > 0
                ? requestedServerId.trim()
                : focus.activeServerId;
            const serverUrl = serverUrls[requested];
            return serverUrl ? { serverId: requested, serverUrl } : null;
        }),
        focusActiveServer: (serverId: string) => {
            focus.activeServerId = serverId;
        },
        resetEndpoints,
        replaceEndpoint: (serverId: string, endpoint: typeof endpointsByServerId[string]) => {
            endpointsByServerId[serverId] = endpoint;
        },
        removeEndpoint: (serverId: string) => {
            delete endpointsByServerId[serverId];
        },
        markFiniteTransferRpcEligible: (serverId: string) => {
            finiteTransferRpcEligibleServerIds.add(serverId);
        },
        omitCurrentEndpointHints: (serverId: string) => {
            identityOnlyEndpointServerIds.add(serverId);
        },
        removeCurrentTransferSupport: (serverId: string) => {
            currentTransferSupportedServerIds.delete(serverId);
        },
        isFiniteTransferRpcEligible: (serverId: string) => finiteTransferRpcEligibleServerIds.has(serverId),
        isCurrentEndpointIdentityOnly: (serverId: string) => identityOnlyEndpointServerIds.has(serverId),
        isCurrentTransferSupported: (serverId: string) => currentTransferSupportedServerIds.has(serverId),
        readEndpoint: (serverId: string) => endpointsByServerId[serverId],
    };
});

const targetToken = 'header.eyJzdWIiOiJhY2NvdW50LWIifQ.signature';

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return await createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: (serverUrl, options) => boundaries.getCredentials(serverUrl, options),
        },
    });
});
vi.mock('@/sync/domains/machines/peer/mediation/stream/productionRouteHttp', () => ({
    resolveTargetServer: (requestedServerId?: string | null) => boundaries.resolveTargetServer(requestedServerId),
    requestPeerRouteGrantV2: (...args: unknown[]) => boundaries.requestGrant(...args),
}));
vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (...args: unknown[]) => boundaries.getReadyServerFeatures(...args),
}));
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => ({ serverId: 'server-a', accountId: 'account-a' }),
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerId: () => 'server-a',
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    captureServerRequestAuthorityForServerAccountScope: (...args: unknown[]) => boundaries.captureAuthority(...args),
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
        getState: () => ({
            machineListByServerId: {
                'server-1': [
                    {
                        id: 'machine-1',
                        kind: boundaries.isFiniteTransferRpcEligible('server-1') ? 'ephemeral_session_runner' : 'persistent',
                        active: true,
                        revokedAt: null,
                        operationProtocolCapabilities: {
                            ...(boundaries.isFiniteTransferRpcEligible('server-1') ? { finiteTransferRpc: { protocolVersions: [1] } } : {}),
                            ...(boundaries.readEndpoint('server-1') ? { irohMachineEndpoint: {
                                protocolVersions: [1],
                                ...(boundaries.isCurrentEndpointIdentityOnly('server-1')
                                    ? { endpointId: boundaries.readEndpoint('server-1')!.endpointId }
                                    : boundaries.readEndpoint('server-1')),
                            } } : {}),
                        },
                        operationProtocolCapabilitiesRevision: 1,
                        daemonState: boundaries.isFiniteTransferRpcEligible('server-1') ? null : {
                            ...(boundaries.isCurrentTransferSupported('server-1') ? {
                                transfer: {
                                    supported: { import: true, export: true },
                                    listenerClasses: {
                                        loopback_http: { enabled: false, configured: false, active: false },
                                        tailscale_serve_https: { enabled: false, configured: false, active: false },
                                    },
                                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                                },
                            } : {}),
                            peerMediation: {
                                iroh: {
                                    endpoint: boundaries.readEndpoint('server-1'),
                                },
                            },
                        },
                    },
                ],
                // A second focused home with its own distinct iroh endpoint so
                // a mis-scoped acquisition is observable in minted grants.
                'server-2': [
                    {
                        id: 'machine-1',
                        kind: boundaries.isFiniteTransferRpcEligible('server-2') ? 'ephemeral_session_runner' : 'persistent',
                        active: true,
                        revokedAt: null,
                        operationProtocolCapabilities: {
                            ...(boundaries.isFiniteTransferRpcEligible('server-2') ? { finiteTransferRpc: { protocolVersions: [1] } } : {}),
                            ...(boundaries.readEndpoint('server-2') ? { irohMachineEndpoint: {
                                protocolVersions: [1],
                                ...(boundaries.isCurrentEndpointIdentityOnly('server-2')
                                    ? { endpointId: boundaries.readEndpoint('server-2')!.endpointId }
                                    : boundaries.readEndpoint('server-2')),
                            } } : {}),
                        },
                        operationProtocolCapabilitiesRevision: 1,
                        daemonState: boundaries.isFiniteTransferRpcEligible('server-2') ? null : {
                            ...(boundaries.isCurrentTransferSupported('server-2') ? {
                                transfer: {
                                    supported: { import: true, export: true },
                                    listenerClasses: {
                                        loopback_http: { enabled: false, configured: false, active: false },
                                        tailscale_serve_https: { enabled: false, configured: false, active: false },
                                    },
                                    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
                                },
                            } : {}),
                            peerMediation: {
                                iroh: {
                                    endpoint: boundaries.readEndpoint('server-2'),
                                },
                            },
                        },
                    },
                ],
            },
            machines: {},
        }),
    },
    });
});
vi.mock('@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle', () => ({
    getIrohApplicationEndpoint: async () => ({ endpointId: 'b'.repeat(64) }),
    isIrohMachineTransferLifecycleAvailable: () => true,
    probeIrohMachineTransferLifecycleAvailability: () => boundaries.probeNative(),
    startIrohMachineTransferTunnel: (...args: unknown[]) => boundaries.startTunnel(...args),
}));
vi.mock('@/sync/runtime/browserIroh/hostEligibility', () => ({
    isBrowserIrohHost: () => boundaries.browserHostEligible(),
}));
vi.mock('@/sync/runtime/browserIroh', () => ({
    resolvePackagedBrowserIrohEndpointClient: () => boundaries.resolvePackagedClient(),
    createBrowserMachineCarrierEndpointBinding: (...args: unknown[]) => boundaries.createBrowserBinding(...args),
    createBrowserIrohHttpConnectionRequester: (...args: unknown[]) => boundaries.createBrowserHttpConnection(...args),
}));
vi.mock('./machineCarrierBrowserStream', () => ({
    acquireBrowserMachineCarrierStreamLease: (...args: unknown[]) => boundaries.acquireBrowserStream(...args),
}));

describe('resolveMachineCarrierRoute', () => {
    it('refuses changed or mismatched captured Account custody before opening the carrier', async () => {
        boundaries.requestGrant.mockResolvedValueOnce({ ok: false, reasonCode: 'unexpected_grant_after_retirement' });
        const route = await resolveMachineCarrierRoute('machine-1', 'server-1');
        if (route.kind !== 'iroh_peer') throw new Error('Expected finite carrier');
        await expect(route.acquire({ operationId: 'owned-transfer', accountLifetime: {
            scope: { serverId: 'server-1', accountId: 'original-account' }, isCurrent: () => false,
            onRetire: () => ({ dispose: () => {} }),
        } })).rejects.toMatchObject({ cause: { message: 'action_account_scope_changed' } });
        expect(boundaries.startTunnel).not.toHaveBeenCalled();
        expect(boundaries.requestGrant).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        boundaries.resolveTargetServer.mockClear();
        boundaries.focusActiveServer('server-1');
        boundaries.resetEndpoints();
        boundaries.getCredentials.mockReset();
        boundaries.getCredentials.mockResolvedValue({ token: targetToken });
        boundaries.captureAuthority.mockReset();
        boundaries.captureAuthority.mockResolvedValue({
            scope: { serverId: 'server-1', accountId: 'account-b' },
            request: vi.fn(),
            release: boundaries.releaseAuthority,
        });
        boundaries.requestGrant.mockReset();
        boundaries.startTunnel.mockReset();
        boundaries.probeNative.mockClear();
        boundaries.browserHostEligible.mockReset();
        boundaries.browserHostEligible.mockReturnValue(false);
        boundaries.getReadyServerFeatures.mockClear();
    });

    it('refuses a finite transfer when a browser target has no configured relay', async () => {
        boundaries.browserHostEligible.mockReturnValue(true);
        await expect(resolveMachineCarrierRoute('machine-1', 'server-1')).resolves.toMatchObject({
            kind: 'iroh_peer',
            carrierKind: 'browser_stream',
        });
        boundaries.getReadyServerFeatures.mockClear();
        boundaries.acquireBrowserStream.mockClear();
        boundaries.replaceEndpoint('server-1', {
            endpointId: 'a'.repeat(64),
            directAddresses: ['127.0.0.1:48123'],
            relayUrls: [],
        });
        boundaries.omitCurrentEndpointHints('server-1');

        await expect(resolveMachineCarrierRoute('machine-1', 'server-1')).resolves.toMatchObject({
            kind: 'unavailable', errorCode: 'machine_carrier_unavailable',
        });
        expect(boundaries.acquireBrowserStream).not.toHaveBeenCalled();
    });

    it('does not revive relay hints from stale daemon state after current publication removes them', async () => {
        boundaries.browserHostEligible.mockReturnValue(true);
        boundaries.omitCurrentEndpointHints('server-1');
        await expect(resolveMachineCarrierRoute('machine-1', 'server-1')).resolves.toMatchObject({
            kind: 'unavailable', errorCode: 'machine_carrier_unavailable',
        });
        expect(boundaries.acquireBrowserStream).not.toHaveBeenCalled();
    });

    it('does not select Iroh from endpoint publication without current finite-transfer support', async () => {
        boundaries.browserHostEligible.mockReturnValue(true);
        boundaries.removeCurrentTransferSupport('server-1');

        await expect(resolveMachineCarrierRoute('machine-1', 'server-1')).resolves.toMatchObject({
            kind: 'unavailable',
            errorCode: 'machine_carrier_unavailable',
        });
        expect(boundaries.acquireBrowserStream).not.toHaveBeenCalled();
    });

    it('returns a typed unavailable route for a current Runner without an Iroh endpoint', async () => {
        boundaries.removeEndpoint('server-1');
        boundaries.markFiniteTransferRpcEligible('server-1');

        await expect(resolveMachineCarrierRoute('machine-1', 'server-1')).resolves.toMatchObject({
            kind: 'unavailable', errorCode: 'machine_carrier_unavailable',
        });
        expect(boundaries.probeNative).not.toHaveBeenCalled();
        expect(boundaries.requestGrant).not.toHaveBeenCalled();
        expect(boundaries.startTunnel).not.toHaveBeenCalled();
    });

    it('selects current Runner Iroh without daemon state and never probes Machine RPC', async () => {
        boundaries.markFiniteTransferRpcEligible('server-1');
        await expect(resolveMachineCarrierRoute('machine-1', 'server-1')).resolves.toMatchObject({
            kind: 'iroh_peer', carrierKind: 'native_http',
        });
    });

    it('selects current Runner browser Iroh from authenticated capability relay hints', async () => {
        boundaries.markFiniteTransferRpcEligible('server-1');
        boundaries.browserHostEligible.mockReturnValue(true);
        await expect(resolveMachineCarrierRoute('machine-1', 'server-1')).resolves.toMatchObject({
            kind: 'iroh_peer', carrierKind: 'browser_stream',
        });
    });

    it('pins deferred acquisition to the server resolved at route time when focus moves before acquisition', async () => {
        boundaries.requestGrant.mockImplementationOnce(async ({ request }) => ({
            ok: true,
            value: {
                payload: {
                    v: 2,
                    grantId: 'grant-v2',
                    accountId: 'account-b',
                    machineId: 'machine-1',
                    flowKind: 'bounded_transfer',
                    routeKind: 'iroh_peer',
                    scope: request.scope,
                    iat: 1_000,
                    exp: 301_000,
                    aud: 'happier-daemon-route-grant',
                    endpointFingerprint: 'a'.repeat(64),
                    proofKind: 'ephemeral_ed25519',
                    ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
                    iroh: request.iroh,
                },
                signature: {
                    keyId: 'key-1',
                    alg: 'Ed25519',
                    valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url'),
                },
            },
        }));
        boundaries.startTunnel.mockResolvedValueOnce({
            localOrigin: 'http://127.0.0.1:48124',
            release: vi.fn(),
        });
        // Route selection runs while Home A (server-1) is focused.
        const route = await resolveMachineCarrierRoute('machine-1');
        if (route.kind !== 'iroh_peer') {
            throw new Error('expected an iroh_peer route while Home A is focused');
        }
        // Focus moves to Home B before the deferred acquisition runs.
        boundaries.focusActiveServer('server-2');
        const lease = await route.acquire({
            operationId: 'prepared-file-1',
        });
        expect(route.carrierKind).toBe('native_http');
        expect(lease.kind).toBe('native_http');

        // Credentials, request authority, grant mint, and native tunnel stay
        // pinned to the Home A server selected at route time.
        expect(boundaries.getCredentials).toHaveBeenCalledWith(
            'https://server.example.test',
            { serverId: 'server-1' },
        );
        expect(boundaries.captureAuthority).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({ serverId: 'server-1' }),
        }));
        expect(boundaries.requestGrant).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                endpointFingerprint: 'a'.repeat(64),
                iroh: expect.objectContaining({
                    target: { machineId: 'machine-1', endpointId: 'a'.repeat(64) },
                }),
            }),
        }));
        expect(boundaries.startTunnel).toHaveBeenCalledWith(expect.objectContaining({
            endpointId: 'a'.repeat(64),
            relayUrls: ['https://relay.example.test'],
        }));
    });

    it('selects the browser stream carrier without probing the native lifecycle', async () => {
        boundaries.browserHostEligible.mockReturnValue(true);
        const route = await resolveMachineCarrierRoute('machine-1', 'server-1');

        expect(route).toMatchObject({ kind: 'iroh_peer', carrierKind: 'browser_stream' });
        expect(boundaries.probeNative).not.toHaveBeenCalled();
        expect(boundaries.startTunnel).not.toHaveBeenCalled();
    });
});

describe('acquireMachineCarrierHttpLease', () => {
    beforeEach(() => {
        boundaries.resolveTargetServer.mockClear();
        boundaries.focusActiveServer('server-1');
        boundaries.resetEndpoints();
        boundaries.getCredentials.mockReset();
        boundaries.requestGrant.mockReset();
        boundaries.startTunnel.mockReset();
        boundaries.captureAuthority.mockReset();
        boundaries.releaseAuthority.mockReset();
        boundaries.getCredentials.mockResolvedValue({ token: targetToken });
        boundaries.captureAuthority.mockResolvedValue({
            scope: { serverId: 'server-1', accountId: 'account-b' },
            request: vi.fn(),
            release: boundaries.releaseAuthority,
        });
    });

    it('rejects an invalid V2 grant before native startup', async () => {
        boundaries.requestGrant.mockResolvedValueOnce({ ok: false, reasonCode: 'grant_invalid' });
        await expect(acquireMachineCarrierHttpLease({
            operationId: 'prepared-file-1',
            machineId: 'machine-1',
            serverId: 'server-1',
        })).rejects.toThrow('grant_invalid');

        expect(boundaries.requestGrant).toHaveBeenCalledWith(expect.objectContaining({
            authority: expect.objectContaining({
                scope: { serverId: 'server-1', accountId: 'account-b' },
            }),
            request: expect.objectContaining({
                routeKind: 'iroh_peer',
                scope: { kind: 'bounded_transfer', mode: 'carrier' },
                iroh: {
                    initiator: { kind: 'account_client', endpointId: 'b'.repeat(64) },
                    target: { machineId: 'machine-1', endpointId: 'a'.repeat(64) },
                    operationKind: 'finite_transfer',
                },
            }),
        }));
        expect(boundaries.captureAuthority).toHaveBeenCalledWith(expect.objectContaining({
            scope: { serverId: 'server-1', accountId: 'account-b' },
        }));
        expect(boundaries.releaseAuthority).toHaveBeenCalledTimes(1);
        expect(boundaries.startTunnel).not.toHaveBeenCalled();
    });

    it('uses Home B scoped credentials while Home A is focused and takes handshake accountId from the signed grant', async () => {
        boundaries.requestGrant.mockImplementationOnce(async ({ request }) => ({
            ok: true,
            value: {
                payload: {
                    v: 2,
                    grantId: 'grant-v2',
                    accountId: 'account-b',
                    machineId: 'machine-1',
                    flowKind: 'bounded_transfer',
                    routeKind: 'iroh_peer',
                    scope: request.scope,
                    iat: 1_000,
                    exp: 301_000,
                    aud: 'happier-daemon-route-grant',
                    endpointFingerprint: 'a'.repeat(64),
                    proofKind: 'ephemeral_ed25519',
                    ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
                    iroh: request.iroh,
                },
                signature: {
                    keyId: 'key-1',
                    alg: 'Ed25519',
                    valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url'),
                },
            },
        }));
        boundaries.startTunnel.mockResolvedValueOnce({
            localOrigin: 'http://127.0.0.1:48124',
            release: vi.fn(),
        });
        await acquireMachineCarrierHttpLease({
            operationId: 'prepared-file-1',
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        expect(boundaries.requestGrant).toHaveBeenCalledWith(expect.objectContaining({
            authority: expect.objectContaining({
                scope: { serverId: 'server-1', accountId: 'account-b' },
            }),
        }));
        expect(boundaries.getCredentials).toHaveBeenCalledWith(
            'https://server.example.test',
            { serverId: 'server-1' },
        );
        expect(boundaries.captureAuthority).toHaveBeenCalledWith(expect.objectContaining({
            scope: { serverId: 'server-1', accountId: 'account-b' },
        }));
        const tunnelInput = boundaries.startTunnel.mock.calls[0]?.[0] as { handshakeJson: string };
        expect(JSON.parse(tunnelInput.handshakeJson)).toMatchObject({ accountId: 'account-b' });
        expect(boundaries.releaseAuthority).toHaveBeenCalledTimes(1);
    });

    it('uses the newest direct and relay hints for the signed target endpoint after grant minting', async () => {
        boundaries.requestGrant.mockImplementationOnce(async ({ request }) => {
            boundaries.replaceEndpoint('server-1', {
                endpointId: 'a'.repeat(64),
                directAddresses: ['127.0.0.1:49123'],
                relayUrls: ['https://relay-new.example.test'],
            });
            boundaries.focusActiveServer('server-2');
            return {
                ok: true,
                value: {
                    payload: {
                        v: 2,
                        grantId: 'grant-v2-fresh-hints',
                        accountId: 'account-b',
                        machineId: 'machine-1',
                        flowKind: 'bounded_transfer',
                        routeKind: 'iroh_peer',
                        scope: request.scope,
                        iat: 1_000,
                        exp: 301_000,
                        aud: 'happier-daemon-route-grant',
                        endpointFingerprint: 'a'.repeat(64),
                        proofKind: 'ephemeral_ed25519',
                        ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
                        iroh: request.iroh,
                    },
                    signature: {
                        keyId: 'key-1',
                        alg: 'Ed25519',
                        valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url'),
                    },
                },
            };
        });
        boundaries.startTunnel.mockResolvedValueOnce({
            localOrigin: 'http://127.0.0.1:48124',
            release: vi.fn(),
        });
        await acquireMachineCarrierHttpLease({
            operationId: 'prepared-file-fresh-hints',
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        expect(boundaries.startTunnel).toHaveBeenCalledWith(expect.objectContaining({
            endpointId: 'a'.repeat(64),
            directAddresses: ['127.0.0.1:49123'],
            relayUrls: ['https://relay-new.example.test'],
        }));
    });

    it('rejects when the signed grant target does not match the captured machine endpoint', async () => {
        boundaries.requestGrant.mockImplementationOnce(async ({ request }) => {
            return {
                ok: true,
                value: {
                    payload: {
                        v: 2,
                        grantId: 'grant-v2-stale-target',
                        accountId: 'account-b',
                        machineId: 'machine-1',
                        flowKind: 'bounded_transfer',
                        routeKind: 'iroh_peer',
                        scope: request.scope,
                        iat: 1_000,
                        exp: 301_000,
                        aud: 'happier-daemon-route-grant',
                        endpointFingerprint: 'd'.repeat(64),
                        proofKind: 'ephemeral_ed25519',
                        ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
                        iroh: {
                            ...request.iroh,
                            target: { machineId: 'machine-1', endpointId: 'd'.repeat(64) },
                        },
                    },
                    signature: {
                        keyId: 'key-1',
                        alg: 'Ed25519',
                        valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url'),
                    },
                },
            };
        });
        await expect(acquireMachineCarrierHttpLease({
            operationId: 'prepared-file-stale-target',
            machineId: 'machine-1',
            serverId: 'server-1',
        })).rejects.toThrow();
        expect(boundaries.startTunnel).not.toHaveBeenCalled();
    });
});

describe('acquireBrowserMachineCarrierHttpLease', () => {
    beforeEach(() => {
        // No auto-clear exists in this file: each browser-path test asserts
        // exact call counts, so the per-tab resolution, binding, stream, and
        // connection boundaries start from zero for every test.
        boundaries.resolvePackagedClient.mockClear();
        boundaries.createBrowserBinding.mockClear();
        boundaries.acquireBrowserStream.mockClear();
        boundaries.createBrowserHttpConnection.mockClear();
    });

    it('resolves the shared per-tab client and never closes it across acquire failure and release', async () => {
        // The shared packaged client is the tab's lifecycle owner (Lane 06):
        // a transfer releases its own stream and endpoint lease, and pagehide
        // plus explicit application-data clearing remain the whole-client
        // owners — never a per-transfer `close`.
        const endpointClient = { close: vi.fn() };
        const binding = {
            acquireEndpointLease: vi.fn(),
            openMachineCarrierStream: vi.fn(),
        };
        const duplex = {
            remoteEndpointId: 'a'.repeat(64),
            observedPath: 'relay' as const,
            read: vi.fn(),
            write: vi.fn(),
            finishWrite: vi.fn(),
            cancel: vi.fn(),
            close: vi.fn(),
        };
        const request = vi.fn();
        const close = vi.fn(async () => undefined);
        boundaries.resolvePackagedClient.mockReturnValue(endpointClient);
        boundaries.createBrowserBinding.mockReturnValue(binding);
        boundaries.acquireBrowserStream.mockRejectedValue(new Error('machine carrier admission refused'));

        await expect(acquireBrowserMachineCarrierHttpLease({
            operationId: 'prepared-browser-failed',
            machineId: 'machine-1',
            serverId: 'server-1',
        })).rejects.toThrow('machine carrier admission refused');

        expect(boundaries.resolvePackagedClient).toHaveBeenCalledTimes(1);
        expect(endpointClient.close).not.toHaveBeenCalled();

        boundaries.acquireBrowserStream.mockResolvedValue({
            kind: 'browser_stream',
            remoteEndpointId: 'a'.repeat(64),
            observedPath: 'relay',
            handshakeJson: '{}',
            duplex,
            release: vi.fn(async () => undefined),
        });
        boundaries.createBrowserHttpConnection.mockReturnValue({ request, close, cancel: vi.fn() });

        const lease = await acquireBrowserMachineCarrierHttpLease({
            operationId: 'prepared-browser-transfer',
            machineId: 'machine-1',
            serverId: 'server-1',
        });
        if (lease.kind !== 'browser_stream') throw new Error('expected browser stream lease');

        await lease.request('http://machine.invalid/open');
        await Promise.all([lease.release(), lease.release()]);

        // One shared client for both acquisitions, and releasing the transfer
        // closed the connection — not the tab's client.
        expect(boundaries.resolvePackagedClient).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(endpointClient.close).not.toHaveBeenCalled();
    });

    it('holds one endpoint lease, signed grant, and admitted stream for every HTTP request in the transfer', async () => {
        const endpointClient = { close: vi.fn() };
        const binding = {
            acquireEndpointLease: vi.fn(),
            openMachineCarrierStream: vi.fn(),
        };
        const streamRelease = vi.fn(async () => undefined);
        const duplex = {
            remoteEndpointId: 'a'.repeat(64),
            observedPath: 'relay' as const,
            read: vi.fn(),
            write: vi.fn(),
            finishWrite: vi.fn(),
            cancel: vi.fn(),
            close: vi.fn(),
        };
        const request = vi.fn();
        const close = vi.fn(async () => undefined);
        boundaries.resolvePackagedClient.mockReturnValue(endpointClient);
        boundaries.createBrowserBinding.mockReturnValue(binding);
        boundaries.acquireBrowserStream.mockResolvedValue({
            kind: 'browser_stream',
            remoteEndpointId: 'a'.repeat(64),
            observedPath: 'relay',
            handshakeJson: '{}',
            duplex,
            release: streamRelease,
        });
        boundaries.createBrowserHttpConnection.mockReturnValue({ request, close, cancel: vi.fn() });

        const lease = await acquireBrowserMachineCarrierHttpLease({
            operationId: 'prepared-browser-transfer',
            machineId: 'machine-1',
            serverId: 'server-1',
        });
        if (lease.kind !== 'browser_stream') throw new Error('expected browser stream lease');

        await lease.request('http://machine.invalid/open');
        await lease.request('http://machine.invalid/chunks/0');
        await Promise.all([lease.release(), lease.release()]);

        expect(boundaries.resolvePackagedClient).toHaveBeenCalledTimes(1);
        expect(boundaries.createBrowserBinding).toHaveBeenCalledTimes(1);
        expect(boundaries.acquireBrowserStream).toHaveBeenCalledTimes(1);
        expect(boundaries.acquireBrowserStream).toHaveBeenCalledWith(expect.objectContaining({
            operationId: 'prepared-browser-transfer',
            machineId: 'machine-1',
            serverId: 'server-1',
            acquireEndpointLease: binding.acquireEndpointLease,
            openMachineCarrierStream: binding.openMachineCarrierStream,
        }));
        expect(request).toHaveBeenCalledTimes(2);
        expect(close).toHaveBeenCalledTimes(1);
        // Releasing the transfer releases the stream and its endpoint lease
        // through the connection close — the shared per-tab client stays.
        expect(endpointClient.close).not.toHaveBeenCalled();
    });
});
