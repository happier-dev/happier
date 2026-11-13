import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FeaturesResponseSchema,
    type FeaturesResponse} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    PEER_MEDIATION_RECEIPTS} from '@happier-dev/protocol/machines/peer/mediation/receipts';
import {
    MACHINE_LIVE_STREAM_RELAY_AUTHORIZATION_AUDIENCE_V1,
    type MachineLiveStreamRelayAuthorizationV1,
} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';

const getReadyServerFeaturesSpy = vi.hoisted(() => vi.fn());
const TOKEN_A = 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
const getCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const captureAuthoritySpy = vi.hoisted(() => vi.fn());
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

vi.mock('@/sync/http/client', () => ({
    serverFetch: async (path: string, init?: RequestInit) => {
        const active = getActiveServerSnapshotSpy() as { serverUrl: string };
        const credentials = await getCredentialsForServerUrlSpy() as { token: string };
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${credentials.token}`);
        return await fetch(`${active.serverUrl}${path}`, { ...init, headers });
    },
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
        },
    });
});

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>(),
    getActiveServerSnapshot: (...args: unknown[]) => getActiveServerSnapshotSpy(...args),
}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    getAppliedActiveServerId: () => String((getActiveServerSnapshotSpy() as { serverId?: unknown })?.serverId ?? ''),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    captureServerRequestAuthorityForServerAccountScope: (...args: unknown[]) => captureAuthoritySpy(...args),
    createServerRequestWithServerScope: ({ activeRequest }: { activeRequest: (path: string, init?: RequestInit) => Promise<Response> }) => activeRequest,
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

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
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

vi.mock('@/sync/domains/state/storage', () => {
    // This route test only needs the boundary store snapshot; the shared storage
    // testkit imports local-settings defaults, which currently reaches unrelated theme state.
    const storage = Object.assign(
        (selector?: (value: typeof storageSnapshot.state) => unknown) => (
            typeof selector === 'function' ? selector(storageSnapshot.state) : storageSnapshot.state
        ),
        {
            getState: () => ({
                settingsScope: { serverId: 'server-a', accountId: 'account-1' },
                settings: { peerMediationPreferencesV1: { v: 1, flows: {}, byMachineId: {} } },
                ...storageSnapshot.state,
            }),
            getInitialState: () => storageSnapshot.state,
            setState: () => undefined,
            subscribe: () => () => undefined,
            destroy: () => undefined,
        },
    );
    return {
        storage,
        getStorage: () => storage,
    };
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
    return await import('./productionRoute');
}

function resetRouteBoundary() {
        getReadyServerFeaturesSpy.mockReset();
        getCredentialsForServerUrlSpy.mockReset();
        getActiveServerSnapshotSpy.mockReset();
        listServerProfilesSpy.mockReset();
        captureAuthoritySpy.mockReset();
        vi.unstubAllGlobals();
        storageSnapshot.state = { machines: {}, machineListByServerId: {} };
        getActiveServerSnapshotSpy.mockReturnValue({
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 1,
        });
        listServerProfilesSpy.mockReturnValue([]);
        getReadyServerFeaturesSpy.mockResolvedValue(createFeaturePayload());
        getCredentialsForServerUrlSpy.mockResolvedValue({
            token: TOKEN_A,
            secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
        });
        captureAuthoritySpy.mockImplementation(async ({ scope, activeRequest }) => ({
            scope,
            request: activeRequest,
            release: async () => {},
        }));
}

// Install the existing Home boundary before collecting the real route graph.
resetRouteBoundary();
await importProductionRoute();

describe('production peer mediation live-stream route adapter', () => {
    beforeEach(resetRouteBoundary);

    it('applies the canonical stream gate before minting an otherwise enabled relay', async () => {
        const features = createFeaturePayload();
        features.features.machines.liveStream.enabled = false;
        getReadyServerFeaturesSpy.mockResolvedValue(features);
        const fetchSpy = vi.fn(async () => responseJson({ ok: true, relayAuthorization: createRelayAuthorization() }));
        vi.stubGlobal('fetch', fetchSpy);
        const { startProductionMachineLiveStream } = await importProductionRoute();
        const result = await startProductionMachineLiveStream({
            sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
            routeKind: 'server_relay', streamId: 'stream_1', streamFamily: 'screen',
            caps: { maxBitrateBps: 64_000, maxFramesPerSecond: 12, maxFrameBytes: 32_000, maxDurationMs: 60_000 },
        });
        expect(result).toEqual({ ok: false, reasonCode: 'stream_unsupported' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('uses the grant owner effective caps and negotiated codec in the daemon start', async () => {
        const authorization = createRelayAuthorization();
        authorization.payload.codecId = 'image.mjpeg';
        authorization.payload.viewerCodecs = ['image.mjpeg'];
        let mintBody: unknown;
        vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            mintBody = JSON.parse(String(init?.body));
            return responseJson({ ok: true, relayAuthorization: authorization });
        }));
        const { startProductionMachineLiveStream } = await importProductionRoute();
        const result = await startProductionMachineLiveStream({
            sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
            routeKind: 'server_relay', streamId: 'stream_1', streamFamily: 'screen',
            caps: {}, codecId: 'image.mjpeg', viewerCodecs: ['image.mjpeg'],
        });
        expect(result).toMatchObject({ ok: true, routeKind: 'server_relay', startRequest: {
            maxBitrateBps: authorization.payload.maxBitrateBps,
            maxFramesPerSecond: authorization.payload.maxFramesPerSecond,
            maxFrameBytes: authorization.payload.maxFrameBytes,
            maxDurationMs: authorization.payload.maxDurationMs,
            codecId: 'image.mjpeg', viewerCodecs: ['image.mjpeg'],
        } });
        expect(mintBody).toMatchObject({ codecId: 'image.mjpeg', viewerCodecs: ['image.mjpeg'] });
    });

    it('does not mint a direct grant when the carrier is unavailable even with stored preferences', async () => {
        storageSnapshot.state = {
            settingsScope: { serverId: 'server-a', accountId: 'account-1' },
            settings: {
                peerMediationPreferencesV1: {
                    v: 1,
                    flows: { live_stream: { direct: 'enabled' } },
                    byMachineId: { machine_source: { flows: { live_stream: { direct: 'disabled' } } } },
                },
            },
            machines: {}, machineListByServerId: {},
        };
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const { startProductionMachineLiveStream } = await importProductionRoute();
        const result = await startProductionMachineLiveStream({
            sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
            routeKind: 'loopback_direct', streamId: 'stream_1', streamFamily: 'screen',
            caps: { maxBitrateBps: 64_000, maxFramesPerSecond: 12, maxFrameBytes: 32_000, maxDurationMs: 60_000 },
        });
        expect(result).toEqual({ ok: false, reasonCode: 'topology_unavailable' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });



    it('does not admit a published direct endpoint without a complete delivery carrier', async () => {
        storageSnapshot.state = {
            machines: {
                machine_source: {
                    id: 'machine_source',
                    daemonState: { peerMediation: { loopback: { endpoint: {
                        v: 1, routeKind: 'loopback_direct',
                        url: 'http://127.0.0.1:46021',
                        endpointFingerprint: 'endpoint_stream_1', expiresAt: Date.now() + 60_000,
                    } } } },
                },
            },
            machineListByServerId: {},
        };
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const { startProductionMachineLiveStream } = await importProductionRoute();
        const result = await startProductionMachineLiveStream({
            serverId: 'server-a', sourceMachineId: 'machine_source', targetMachineId: 'machine_target',
            routeKind: 'loopback_direct', streamId: 'stream_1', streamFamily: 'screen', caps: {},
        });
        expect(result).toEqual({ ok: false, reasonCode: 'topology_unavailable' });
        expect(fetchSpy).not.toHaveBeenCalled();
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

    // W1-C-2 cross-boundary contract: the per-tab viewer socket id must travel from the UI relay
    // request, through the server mint request body, into the SIGNED relay-authorization payload,
    // and back out on the start request — where the protocol `MachineLiveStreamStartRequestV1`
    // superRefine asserts `request.viewerSocketId === payload.viewerSocketId`. The only mocked
    // boundary is `fetch` (network); the mint handler echoes the request `viewerSocketId` into the
    // grant payload exactly as the real server mint does (`relayAuthorization.ts` binds it), and the
    // start request is built by the real `createLiveStreamStartRequest` which `.parse()`s it, so a
    // missing/divergent id would fail this path rather than pass.
    it('threads viewerSocketId from the relay request into the minted grant and the start request', async () => {
        const viewerSocketId = 'viewer-socket-1';
        let mintBody: Record<string, unknown> | null = null;
        const relayAuthorization = createRelayAuthorization();
        const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/peer/mediation/route-grants') {
                mintBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                // Mirror the real server mint: the signed payload binds the requested viewer socket.
                return responseJson({
                    ok: true,
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
                    relayAuthorization: {
                        ...relayAuthorization,
                        payload: {
                            ...relayAuthorization.payload,
                            viewerSocketId: (mintBody as { viewerSocketId?: unknown }).viewerSocketId,
                        },
                    },
                });
            }
            throw new Error(`unexpected fetch ${parsed.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        const result = await module.startProductionMachineLiveStream({
            serverId: 'server-a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            routeKind: 'server_relay',
            streamId: 'stream_1',
            streamFamily: 'screen',
            viewerSocketId,
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
        });

        // UI→server contract: the mint request body carries the per-tab viewer socket id.
        expect(mintBody).toMatchObject({ viewerSocketId });
        // protocol contract: the signed start request carries it and matches the bound payload.
        expect(result).toMatchObject({
            ok: true,
            routeKind: 'server_relay',
            startRequest: {
                viewerSocketId,
                authorization: { payload: { viewerSocketId } },
            },
        });
    });

    // The protocol superRefine is enforced through the REAL build path: a grant minted for a
    // different tab (a divergent `viewerSocketId`) must not produce a usable start request.
    it('rejects a minted grant whose viewerSocketId diverges from the relay request', async () => {
        const relayAuthorization = createRelayAuthorization();
        let mintedViewerSocketId = 'viewer-socket-1';
        const fetchSpy = vi.fn(async (url: RequestInfo | URL) => {
            const parsed = new URL(String(url));
            if (parsed.pathname === '/v1/machines/peer/mediation/route-grants') {
                return responseJson({
                    ok: true,
                    receipt: PEER_MEDIATION_RECEIPTS.routeGrantMinted,
                    relayAuthorization: {
                        ...relayAuthorization,
                        payload: { ...relayAuthorization.payload, viewerSocketId: mintedViewerSocketId },
                    },
                });
            }
            throw new Error(`unexpected fetch ${parsed.pathname}`);
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        const startStream = () => module.startProductionMachineLiveStream({
            serverId: 'server-a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            routeKind: 'server_relay',
            streamId: 'stream_1',
            streamFamily: 'screen',
            viewerSocketId: 'viewer-socket-1',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
        });
        await expect(startStream()).resolves.toMatchObject({
            ok: true,
            startRequest: { viewerSocketId: 'viewer-socket-1' },
        });

        mintedViewerSocketId = 'viewer-socket-OTHER';
        await expect(startStream()).rejects.toMatchObject({
            issues: expect.arrayContaining([expect.objectContaining({
                code: 'custom',
                path: ['authorization', 'payload', 'viewerSocketId'],
            })]),
        });
    });
});
