import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FeaturesResponseSchema,
    PeerLoopbackEndpointCandidateV1Schema,
    PEER_MEDIATION_RECEIPTS,
    type FeaturesResponse,
    type PeerLoopbackEndpointCandidateV1,
    type PeerMachineRpcDirectRequestV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const getReadyServerFeaturesSpy = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const listServerProfilesSpy = vi.hoisted(() => vi.fn());
const storageSnapshot = vi.hoisted(() => ({
    state: {
        machines: {},
        machineListByServerId: {},
    } as Record<string, unknown>,
}));
const storageGetStateSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (...args: unknown[]) => getReadyServerFeaturesSpy(...args),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(
        credentials
        && typeof credentials === 'object'
        && typeof (credentials as { secret?: unknown }).secret === 'string',
    ),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));

function normalizeServerProfileTestId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function findServerProfileTestDouble(idRaw: unknown): { id: string; serverUrl: string; serverIdentityId?: string | null } | null {
    const id = normalizeServerProfileTestId(idRaw);
    const profiles = listServerProfilesSpy();
    if (!id || !Array.isArray(profiles)) return null;
    return (profiles as Array<{ id: string; serverUrl: string; serverIdentityId?: string | null; legacyServerIds?: readonly string[] }>).find((profile) => (
        normalizeServerProfileTestId(profile.id) === id
        || normalizeServerProfileTestId(profile.serverIdentityId) === id
        || (profile.legacyServerIds ?? []).some((legacyId) => normalizeServerProfileTestId(legacyId) === id)
    )) ?? null;
}

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => {
        const leftId = normalizeServerProfileTestId(left);
        const rightId = normalizeServerProfileTestId(right);
        if (!leftId || !rightId) return false;
        if (leftId === rightId) return true;
        const leftProfile = findServerProfileTestDouble(leftId);
        const rightProfile = findServerProfileTestDouble(rightId);
        return Boolean(leftProfile && rightProfile && leftProfile.id === rightProfile.id);
    },
    getServerProfileById: (id: unknown) => findServerProfileTestDouble(id),
    listServerProfiles: (...args: unknown[]) => listServerProfilesSpy(...args),
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => profile.serverIdentityId ?? profile.id,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit');
    const store = createStorageStoreMock({});
    return createStorageModuleStub({
        storage: Object.assign(store, {
            getState: () => storageGetStateSpy(),
        }),
    });
});

function createFeaturePayload(): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                rpc: {
                    enabled: true,
                    directPeer: { enabled: true },
                },
            },
        },
        capabilities: {},
    });
}

function createGrant(method: string): SignedDirectRouteGrantV1 {
    return {
        payload: {
            v: 1,
            grantId: 'grant_1',
            grantFamilyId: 'grant_family_1',
            accountId: 'account_1',
            machineId: 'machine_1',
            flowKind: 'machine_rpc',
            routeKind: 'loopback_direct',
            scope: {
                kind: 'machine_rpc',
                rpcScopeId: 'machine_1:daemon.memory.status',
                allowedMethods: [method],
                maxCalls: 2,
                maxIdleMs: 30_000,
            },
            iat: 1_000,
            exp: 301_000,
            aud: 'happier-daemon-route-grant',
            endpointFingerprint: 'endpoint_1',
        },
        signature: {
            keyId: 'grant_key_1',
            alg: 'Ed25519',
            valueBase64Url: 'AbCdEf012_-',
        },
    };
}

function createDirectRequest(): PeerMachineRpcDirectRequestV1 {
    return {
        v: 1,
        requestId: 'request_1',
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: { includeWorkers: true },
        grant: createGrant(RPC_METHODS.DAEMON_MEMORY_STATUS),
        nonceProof: {
            v: 1,
            grantId: 'grant_1',
            routeKind: 'loopback_direct',
            flowKind: 'machine_rpc',
            endpointFingerprint: 'endpoint_1',
            nonceBase64Url: 'nonce_1',
            signatureBase64Url: 'AbCdEf012_-',
        },
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'endpoint_1',
    };
}

function responseJson(payload: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: async () => payload,
    } as Response;
}

async function importProductionRoute() {
    return await import('./productionRoute').catch((error: unknown) => ({ importError: error }));
}

describe('production peer mediation machine RPC route adapter', () => {
    beforeEach(() => {
        getReadyServerFeaturesSpy.mockReset();
        getCredentialsForServerUrlSpy.mockReset();
        storageGetStateSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        listServerProfilesSpy.mockReset();
        vi.unstubAllGlobals();
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([]);
        getReadyServerFeaturesSpy.mockResolvedValue(createFeaturePayload());
        getCredentialsForServerUrlSpy.mockResolvedValue({
            token: 'token-a',
            secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
        });
        storageGetStateSpy.mockImplementation(() => storageSnapshot.state);
    });

    it('projects legacy account signing as ready and data-key credentials as typed fail-closed', async () => {
        const module = await importProductionRoute();
        expect(module).toHaveProperty('resolvePeerRouteSigningReadiness');
        if ('importError' in module) throw module.importError;

        expect(module.resolvePeerRouteSigningReadiness({
            token: 'legacy-token',
            secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
        })).toEqual({
            status: 'ready',
            credentialMode: 'legacy_account_signing',
            signingIdentity: 'account_signing_v1',
        });
        expect(module.resolvePeerRouteSigningReadiness({
            token: 'data-key-token',
            encryption: {
                publicKey: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
                machineKey: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
            },
        })).toEqual({
            status: 'unavailable',
            credentialMode: 'data_key_keyless',
            reasonCode: 'peer_route_signing_identity_unavailable',
            requiredCapability: 'peer_route_signing_identity_v1',
        });
    });

    it('selects V2 for data-key credentials only when server mint and daemon verifier capabilities intersect', async () => {
        const endpoint = PeerLoopbackEndpointCandidateV1Schema.parse({
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46011/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_1',
            expiresAt: Date.now() + 60_000,
            directRouteGrantProofVerifierVersions: [2],
        });
        storageSnapshot.state = {
            machines: {
                machine_1: { id: 'machine_1', daemonState: { peerMediation: { loopback: { endpoint } } } },
            },
            machineListByServerId: {},
        };
        getReadyServerFeaturesSpy.mockResolvedValue(FeaturesResponseSchema.parse({
            features: { machines: { enabled: true, rpc: { enabled: true, directPeer: { enabled: true } } } },
            capabilities: { machines: { peerMediation: { directRouteGrantProofMintVersions: [2] } } },
        }));
        getCredentialsForServerUrlSpy.mockResolvedValue({
            token: 'data-key-token',
            encryption: {
                publicKey: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
                machineKey: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
            },
        });
        const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { ephemeralPublicKeyBase64Url: string };
            return responseJson({
                ok: true,
                receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
                grant: {
                    payload: {
                        v: 2,
                        grantId: 'grant_v2',
                        accountId: 'account_1',
                        machineId: 'machine_1',
                        flowKind: 'machine_rpc',
                        routeKind: 'loopback_direct',
                        scope: {
                            kind: 'machine_rpc', rpcScopeId: `machine_1:${RPC_METHODS.DAEMON_MEMORY_STATUS}`,
                            allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS], maxCalls: 2, maxIdleMs: 30_000,
                        },
                        iat: 1_000,
                        exp: 301_000,
                        aud: 'happier-daemon-route-grant',
                        endpointFingerprint: 'endpoint_1',
                        proofKind: 'ephemeral_ed25519',
                        ephemeralPublicKeyBase64Url: body.ephemeralPublicKeyBase64Url,
                    },
                    signature: {
                        keyId: 'grant_key_1', alg: 'Ed25519',
                        valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url'),
                    },
                },
            });
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a', machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toMatchObject({
            kind: 'selected',
            grant: { payload: { v: 2, proofKind: 'ephemeral_ed25519' } },
            proof: { v: 2, kind: 'ephemeral_ed25519' },
        });
        const mintBody = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
        expect(mintBody).toMatchObject({ v: 2, kind: 'ephemeral_ed25519' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fails data-key direct-route readiness before topology lookup or route traffic', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46011/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_1',
            expiresAt: Date.now() + 60_000,
        };
        storageSnapshot.state = {
            machines: {
                machine_1: {
                    id: 'machine_1',
                    daemonState: { peerMediation: { loopback: { endpoint } } },
                },
            },
            machineListByServerId: {},
        };
        getCredentialsForServerUrlSpy.mockResolvedValue({
            token: 'data-key-token',
            encryption: {
                publicKey: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
                machineKey: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
            },
        });
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        expect(module).toHaveProperty('resolveProductionMachineRpcDirectRoute');
        if ('importError' in module) throw module.importError;

        await expect(module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        })).resolves.toEqual({
            kind: 'fallback',
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
            reasonCode: 'peer_route_signing_identity_unavailable',
            requiredCapability: 'peer_route_signing_identity_v1',
        });
        expect(storageGetStateSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not let an absent daemon endpoint mask data-key signing identity unavailability', async () => {
        storageSnapshot.state = { machines: {}, machineListByServerId: {} };
        getCredentialsForServerUrlSpy.mockResolvedValue({
            token: 'data-key-token',
            encryption: {
                publicKey: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
                machineKey: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
            },
        });
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        await expect(module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        })).resolves.toMatchObject({
            kind: 'fallback',
            reasonCode: 'peer_route_signing_identity_unavailable',
            requiredCapability: 'peer_route_signing_identity_v1',
        });
        expect(storageGetStateSpy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resolves a selected direct route from daemon endpoint, server grant, nonce proof, and loopback probe', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46011/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_1',
            expiresAt: Date.now() + 60_000,
        };
        storageSnapshot.state = {
            machines: {
                machine_1: {
                    id: 'machine_1',
                    daemonState: {
                        peerMediation: {
                            loopback: {
                                endpoint,
                            },
                        },
                    },
                },
            },
            machineListByServerId: {},
        };
        const grant = createGrant(RPC_METHODS.DAEMON_MEMORY_STATUS);
        const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/peer/mediation/route-grants') {
                return responseJson({
                    ok: true,
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
                    grant,
                });
            }
            return responseJson({
                v: 1,
                ok: true,
                receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
                routeKind: 'loopback_direct',
                flowKind: 'machine_rpc',
                endpointFingerprint: 'endpoint_1',
            });
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        expect(module).toHaveProperty('resolveProductionMachineRpcDirectRoute');
        if ('importError' in module) throw module.importError;

        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toMatchObject({
            kind: 'selected',
            endpoint: {
                endpointFingerprint: 'endpoint_1',
            },
            grant,
            nonceProof: {
                v: 1,
                grantId: 'grant_1',
                routeKind: 'loopback_direct',
                flowKind: 'machine_rpc',
                endpointFingerprint: 'endpoint_1',
            },
        });
        expect(fetchSpy).toHaveBeenCalledWith(
            'https://server-a.example.test/v1/machines/peer/mediation/route-grants',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-a',
                }),
            }),
        );
        expect(fetchSpy.mock.calls.filter(([url]) =>
            new URL(String(url)).pathname === '/v1/machines/peer/mediation/route-grants',
        )).toHaveLength(1);
    });

    it('fails closed to fallback when grant transport is unavailable', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46012/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_2',
            expiresAt: Date.now() + 60_000,
        };
        storageSnapshot.state = {
            machines: {
                machine_1: {
                    id: 'machine_1',
                    daemonState: {
                        peerMediation: {
                            loopback: {
                                endpoint,
                            },
                        },
                    },
                },
            },
            machineListByServerId: {},
        };
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('route grant network unavailable');
        }));

        const module = await importProductionRoute();
        expect(module).toHaveProperty('resolveProductionMachineRpcDirectRoute');
        if ('importError' in module) throw module.importError;

        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toEqual({
            kind: 'fallback',
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
            reasonCode: 'grant_missing',
        });
    });

    it('fails closed to fallback when the loopback probe transport is unavailable', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46013/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_3',
            expiresAt: Date.now() + 60_000,
        };
        storageSnapshot.state = {
            machines: {
                machine_1: {
                    id: 'machine_1',
                    daemonState: {
                        peerMediation: {
                            loopback: {
                                endpoint,
                            },
                        },
                    },
                },
            },
            machineListByServerId: {},
        };
        const grant = createGrant(RPC_METHODS.DAEMON_MEMORY_STATUS);
        vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/peer/mediation/route-grants') {
                return responseJson({
                    ok: true,
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
                    grant,
                });
            }
            throw new Error('loopback probe unavailable');
        }));

        const module = await importProductionRoute();
        expect(module).toHaveProperty('resolveProductionMachineRpcDirectRoute');
        if ('importError' in module) throw module.importError;

        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toEqual({
            kind: 'fallback',
            receipt: PEER_MEDIATION_RECEIPTS.routeFallback,
            reasonCode: 'topology_unavailable',
        });
    });

    it('forwards the caller abort signal to the direct loopback request', async () => {
        const controller = new AbortController();
        controller.abort();
        let capturedSignal: AbortSignal | undefined;
        const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
            capturedSignal = init?.signal ?? undefined;
            if (init?.signal?.aborted) {
                return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }
            return Promise.resolve(responseJson({ v: 1, ok: true }));
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        expect(module).toHaveProperty('postProductionMachineRpcDirect');
        if ('importError' in module) throw module.importError;

        const result = await module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v1/machine-rpc',
            request: createDirectRequest(),
            signal: controller.signal,
        });

        // The caller signal must reach the actual request transport.
        expect(capturedSignal?.aborted).toBe(true);
        // An aborted direct request degrades to a server-fallback response.
        expect(result).toMatchObject({ ok: false, requestId: 'request_1' });
    });
});
