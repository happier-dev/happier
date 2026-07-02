import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FeaturesResponseSchema,
    PEER_MEDIATION_RECEIPTS,
    MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    type FeaturesResponse,
    type MachineLiveStreamRelayAuthorizationV1,
    type PeerLoopbackEndpointCandidateV1,
    type SignedDirectRouteGrantV1,
} from '@happier-dev/protocol';

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
                liveStream: {
                    enabled: true,
                    directPeer: { enabled: true },
                    serverRouted: { enabled: true },
                },
            },
        },
        capabilities: {
            machines: {
                liveStream: {
                    serverRouted: {
                        caps: {
                            maxBitrateBps: 64_000,
                            maxFramesPerSecond: 12,
                            maxFrameBytes: 32_000,
                            maxDurationMs: 60_000,
                            maxTotalBytes: 128_000,
                            maxConcurrentStreamsPerAccount: 2,
                            maxConcurrentStreamsPerSocket: 1,
                            maxConcurrentStreamsPerMachine: 1,
                        },
                    },
                },
            },
        },
    });
}

function createGrant(): SignedDirectRouteGrantV1 {
    return {
        payload: {
            v: 1,
            grantId: 'grant_stream_1',
            grantFamilyId: 'grant_family_stream_1',
            accountId: 'account_1',
            machineId: 'machine_source',
            flowKind: 'live_stream',
            routeKind: 'loopback_direct',
            scope: {
                kind: 'live_stream',
                streamId: 'stream_1',
                streamFamily: 'screen',
                maxBitrateBps: 64_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
            iat: 1_000,
            exp: 601_000,
            aud: 'happier-daemon-route-grant',
            endpointFingerprint: 'endpoint_stream_1',
        },
        signature: {
            keyId: 'grant_key_1',
            alg: 'Ed25519',
            valueBase64Url: 'AbCdEf012_-',
        },
    };
}

function createRelayAuthorization(): MachineLiveStreamRelayAuthorizationV1 {
    return {
        payload: {
            v: 1,
            grantId: 'relay_grant_stream_1',
            accountId: 'account_1',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            flowKind: 'live_stream',
            routeKind: 'server_relay',
            streamId: 'stream_1',
            streamFamily: 'screen',
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
            iat: 1_000,
            exp: 61_000,
            aud: MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
        },
        signature: {
            keyId: 'relay_key_1',
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

describe('production peer mediation live-stream route adapter', () => {
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

    it('starts a direct live stream through server grant, nonce proof, loopback probe, and loopback start', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46021/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_stream_1',
            expiresAt: Date.now() + 60_000,
        };
        storageSnapshot.state = {
            machines: {
                machine_source: {
                    id: 'machine_source',
                    daemonState: {
                        peerMediation: {
                            loopback: { endpoint },
                        },
                    },
                },
            },
            machineListByServerId: {},
        };
        const grant = createGrant();
        const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/peer/mediation/route-grants') {
                expect(JSON.parse(String(init?.body))).toMatchObject({
                    machineId: 'machine_source',
                    flowKind: 'live_stream',
                    routeKind: 'loopback_direct',
                    endpointFingerprint: 'endpoint_stream_1',
                    scope: {
                        kind: 'live_stream',
                        streamId: 'stream_1',
                    },
                });
                return responseJson({
                    ok: true,
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
                    grant,
                });
            }
            if (parsed.pathname === '/peer-mediation/v1/probe') {
                return responseJson({
                    v: 1,
                    ok: true,
                    receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
                    routeKind: 'loopback_direct',
                    flowKind: 'live_stream',
                    endpointFingerprint: 'endpoint_stream_1',
                });
            }
            if (parsed.pathname === '/peer-mediation/v1/live-stream/start') {
                expect(JSON.parse(String(init?.body))).toMatchObject({
                    v: 1,
                    streamId: 'stream_1',
                    routeKind: 'loopback_direct',
                    flowKind: 'live_stream',
                    endpointFingerprint: 'endpoint_stream_1',
                    grant,
                    nonceProof: {
                        v: 1,
                        grantId: 'grant_stream_1',
                        routeKind: 'loopback_direct',
                        flowKind: 'live_stream',
                        endpointFingerprint: 'endpoint_stream_1',
                    },
                    startRequest: {
                        v: 1,
                        streamId: 'stream_1',
                        routeKind: 'loopback_direct',
                        sourceMachineId: 'machine_source',
                        targetMachineId: 'machine_target',
                    },
                });
                return responseJson({
                    v: 1,
                    ok: true,
                    receipt: PEER_MEDIATION_RECEIPTS.streamStarted,
                    streamId: 'stream_1',
                    routeKind: 'loopback_direct',
                    expiresAtMs: 61_000,
                });
            }
            throw new Error(`unexpected fetch ${parsed.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        expect(module).toHaveProperty('startProductionMachineLiveStream');
        if ('importError' in module) throw module.importError;

        const result = await module.startProductionMachineLiveStream({
            serverId: 'server-a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            routeKind: 'loopback_direct',
            streamId: 'stream_1',
            streamFamily: 'screen',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
        });

        expect(result).toEqual({
            ok: true,
            routeKind: 'loopback_direct',
            response: {
                v: 1,
                ok: true,
                receipt: PEER_MEDIATION_RECEIPTS.streamStarted,
                streamId: 'stream_1',
                routeKind: 'loopback_direct',
                expiresAtMs: 61_000,
            },
        });
        expect(fetchSpy).toHaveBeenCalledWith(
            'http://127.0.0.1:46021/peer-mediation/v1/live-stream/start',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(fetchSpy.mock.calls.filter(([url]) =>
            new URL(String(url)).pathname === '/v1/machines/peer/mediation/route-grants',
        )).toHaveLength(1);
    });

    it('requests relay authorization before building the server-relay start request', async () => {
        const relayAuthorization = createRelayAuthorization();
        const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/peer/mediation/route-grants') {
                expect(JSON.parse(String(init?.body))).toMatchObject({
                    machineId: 'machine_source',
                    targetMachineId: 'machine_target',
                    flowKind: 'live_stream',
                    routeKind: 'server_relay',
                    maxFramesPerSecond: 12,
                    maxFrameBytes: 32_000,
                    scope: {
                        kind: 'live_stream',
                        streamId: 'stream_1',
                        streamFamily: 'screen',
                    },
                });
                return responseJson({
                    ok: true,
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
                    relayAuthorization,
                });
            }
            throw new Error(`unexpected fetch ${parsed.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        expect(module).toHaveProperty('startProductionMachineLiveStream');
        if ('importError' in module) throw module.importError;

        const result = await module.startProductionMachineLiveStream({
            serverId: 'server-a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            routeKind: 'server_relay',
            streamId: 'stream_1',
            streamFamily: 'screen',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
        });

        expect(result).toMatchObject({
            ok: true,
            routeKind: 'server_relay',
            relayAuthorization,
            startRequest: {
                routeKind: 'server_relay',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                authorization: relayAuthorization,
            },
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
