import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FeaturesResponseSchema,
    PEER_MEDIATION_RECEIPTS,
    type FeaturesResponse,
    type PeerLoopbackEndpointCandidateV1,
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
            getState: () => storageSnapshot.state,
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
});
