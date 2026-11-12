import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FeaturesResponseSchema,
    type FeaturesResponse} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import {
    PeerLoopbackEndpointCandidateV1Schema,
    type PeerLoopbackEndpointCandidateV1} from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import {
    PEER_MEDIATION_RECEIPTS} from '@happier-dev/protocol/machines/peer/mediation/receipts';
import {
    type PeerMachineRpcDirectRequestV2,
} from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

const getReadyServerFeaturesSpy = vi.hoisted(() => vi.fn());
const TOKEN_A = 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.signature';
const DATA_KEY_TOKEN = 'header.eyJzdWIiOiJhY2NvdW50LTEifQ.data-key-signature';
const getCredentialsForServerUrlSpy = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotSpy = vi.hoisted(() => vi.fn());
const captureAuthoritySpy = vi.hoisted(() => vi.fn());
const storageSnapshot = vi.hoisted(() => ({
    state: {
        machines: {},
        machineListByServerId: {},
    } as Record<string, unknown>,
}));
const storageGetStateSpy = vi.hoisted(() => vi.fn());
let getSystemTasksRunner: typeof import('@/components/systemTasks/systemTasksRuntime')['getSystemTasksRunner'];
let publishLocalDaemonStatus: typeof import('@/components/settings/machines/localControl/localDaemonSharedState')['publishLocalDaemonStatus'];

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
    return await createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlSpy(...args),
    } });
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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
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


function createDirectRequest(): PeerMachineRpcDirectRequestV2 {
    return {
        v: 2,
        requestId: 'request_1',
        method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        params: { includeWorkers: true },
        grant: {
            payload: {
                v: 2, grantId: 'grant_1', accountId: 'account-1', machineId: 'machine_1',
                flowKind: 'machine_rpc', routeKind: 'loopback_direct',
                scope: { kind: 'machine_rpc', rpcScopeId: 'scope_1', allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS], maxIdleMs: 30_000 },
                iat: 1_000, exp: 301_000, aud: 'happier-daemon-route-grant', endpointFingerprint: 'endpoint_1',
                proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
            },
            signature: { keyId: 'key_1', alg: 'Ed25519', valueBase64Url: Buffer.from(new Uint8Array(64).fill(2)).toString('base64url') },
        },
        proof: {
            v: 2,
            kind: 'ephemeral_ed25519',
            signedGrantDigestBase64Url: Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'),
            nonceBase64Url: 'nonce_1',
            signatureBase64Url: Buffer.from(new Uint8Array(64).fill(2)).toString('base64url'),
        },
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'endpoint_1',
    };
}

function responseJson(payload: unknown): Response {
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

async function importProductionRoute() {
    return await import('./productionRoute').catch((error: unknown) => ({ importError: error }));
}

function resetRouteBoundary() {
    clearMachineRequestReachabilityForTest();
    getReadyServerFeaturesSpy.mockReset();
    getCredentialsForServerUrlSpy.mockReset();
    storageGetStateSpy.mockReset();
    getActiveServerSnapshotSpy.mockReset();
    captureAuthoritySpy.mockReset();
    vi.unstubAllGlobals();
    // Desktop host is the OS boundary; status publication and locality logic stay real.
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
    // Keep the desktop identity real while replacing its native HTTP boundary.
    setRuntimeFetch((input, init) => fetch(input, init));
    storageSnapshot.state = { machines: {}, machineListByServerId: {} };
    getActiveServerSnapshotSpy.mockReturnValue({
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    });
    getReadyServerFeaturesSpy.mockResolvedValue(createFeaturePayload());
    getCredentialsForServerUrlSpy.mockResolvedValue({
        token: TOKEN_A,
        secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    });
    captureAuthoritySpy.mockImplementation(async ({ scope, activeRequest }) => {
        const current = await getCredentialsForServerUrlSpy();
        const payload = JSON.parse(Buffer.from(String(current.token).split('.')[1]!, 'base64url').toString('utf8')) as { sub?: string };
        if (payload.sub !== scope.accountId) throw new Error('Account scope changed');
        return { scope, request: activeRequest, release: async () => {} };
    });
    storageGetStateSpy.mockImplementation(() => ({
        settingsScope: { serverId: 'server-a', accountId: 'account-1' },
        settings: { peerMediationPreferencesV1: { v: 1, flows: {}, byMachineId: {} } },
        ...storageSnapshot.state,
    }));
}

// Runtime initialization reads its Home immediately; install this fixture before loading it.
resetRouteBoundary();
({ getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime'));
({ publishLocalDaemonStatus } = await import('@/components/settings/machines/localControl/localDaemonSharedState'));

describe('production peer mediation machine RPC route adapter', () => {
    afterEach(() => resetRuntimeFetch());

    beforeEach(() => {
        resetRouteBoundary();
        publishLocalDaemonStatus(getSystemTasksRunner(), {
            machineId: 'machine_1', daemonAccountId: 'account-1',
            daemonServerUrl: 'https://server-a.example.test',
        });
    });

    it.each([null, { machineId: 'other-machine', daemonAccountId: 'account-1', daemonServerUrl: 'https://server-a.example.test' },
        { machineId: 'machine_1', daemonAccountId: 'other-account', daemonServerUrl: 'https://server-a.example.test' },
        { machineId: 'machine_1', daemonAccountId: 'account-1', daemonServerUrl: 'https://other-home.example.test' },
    ])('uses Home without a direct POST or probe when local Machine identity is unproven: %j', async (localStatus) => {
        publishLocalDaemonStatus(getSystemTasksRunner(), localStatus);
        storageSnapshot.state = { machines: { machine_1: { id: 'machine_1', daemonState: { peerMediation: { loopback: {
            endpoint: { v: 1, routeKind: 'loopback_direct', url: 'http://127.0.0.1:46011',
                endpointFingerprint: 'endpoint_1', expiresAt: Date.now() + 60_000 },
        } } } } }, machineListByServerId: {} };
        const fetchSpy = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            if (String(url).endsWith('/route-grants')) {
                const body = JSON.parse(String(init?.body)) as { ephemeralPublicKeyBase64Url: string };
                const grant = createDirectRequest().grant;
                return responseJson({ ok: true, grant: { ...grant, payload: { ...grant.payload,
                    ephemeralPublicKeyBase64Url: body.ephemeralPublicKeyBase64Url } } });
            }
            const request = JSON.parse(String(init?.body)) as PeerMachineRpcDirectRequestV2;
            return responseJson({ v: 2, ok: true, receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
                requestId: request.requestId, method: request.method, routeKind: 'loopback_direct', result: { from: 'loopback' } });
        });
        vi.stubGlobal('fetch', fetchSpy);
        const { resolveProductionMachineRpcDirectRoute, postProductionMachineRpcDirect } = await import('./productionRoute');
        const { machineRpcWithPeerMediationRoute } = await import('./client');
        const serverFallback = vi.fn(async () => ({ from: 'Home' }));
        await expect(machineRpcWithPeerMediationRoute({
            serverId: 'server-a', accountId: 'account-1', machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS, payload: {},
            resolveDirectRoute: resolveProductionMachineRpcDirectRoute,
            postDirect: postProductionMachineRpcDirect, serverFallback,
        })).resolves.toEqual({ from: 'Home' });
        expect(serverFallback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reasonCode: 'loopback_locality_unproven' }));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fails closed before route selection when stored credentials belong to another Account', async () => {
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        const result = await module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a',
            accountId: 'account-other',
            machineId: 'machine-1',
            method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });

        expect(result).toMatchObject({ kind: 'fallback', reasonCode: 'grant_missing' });
        expect(storageGetStateSpy).not.toHaveBeenCalled();
    });

    it.each([
        { flows: { machine_rpc: { direct: 'disabled' } }, byMachineId: {} },
        { flows: { machine_rpc: { direct: 'enabled' } }, byMachineId: { machine_1: { flows: { machine_rpc: { direct: 'disabled' } } } } },
    ])('honors the stored direct-route preference before minting a grant: %j', async (preferences) => {
        storageSnapshot.state = {
            settingsScope: { serverId: 'server-a', accountId: 'account-1' },
            settings: { peerMediationPreferencesV1: { v: 1, ...preferences } },
            machines: {},
            machineListByServerId: {},
        };
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        await expect(module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a', machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        })).resolves.toMatchObject({ kind: 'fallback', reasonCode: 'disabled_by_account_preference' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });


    it.each(['secret', 'data-key'] as const)('uses the current ephemeral proof for %s credentials without component-version probes', async (credentialKind) => {
        const endpoint = PeerLoopbackEndpointCandidateV1Schema.parse({
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46011',
            endpointFingerprint: 'endpoint_1',
            expiresAt: Date.now() + 60_000,
        });
        storageSnapshot.state = {
            machines: {
                machine_1: { id: 'machine_1', daemonState: { peerMediation: { loopback: { endpoint } } } },
            },
            machineListByServerId: {},
        };
        getReadyServerFeaturesSpy.mockResolvedValue(FeaturesResponseSchema.parse({
            features: { machines: { enabled: true, rpc: { enabled: true, directPeer: { enabled: true } } } },
        }));
        if (credentialKind === 'data-key') getCredentialsForServerUrlSpy.mockResolvedValue({
            token: DATA_KEY_TOKEN,
            encryption: {
                publicKey: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
                machineKey: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
            },
        });
        const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
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
                            allowedMethods: [RPC_METHODS.DAEMON_MEMORY_STATUS], maxIdleMs: 30_000,
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
        const mintBody = JSON.parse(String(fetchSpy.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body));
        expect(mintBody).toMatchObject({ v: 2, kind: 'ephemeral_ed25519' });
    });


    it('keeps the native workspace single-use carrier outside ordinary RPC admission', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        await expect(module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a', machineId: 'machine_1', method: 'workspace.sync',
        })).resolves.toMatchObject({ kind: 'fallback', reasonCode: 'method_unclassified' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reuses one signed admission for concurrent and subsequent ordinary calls until expiry or disconnect', async () => {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        storageSnapshot.state = { machines: { machine_1: { id: 'machine_1', daemonState: { peerMediation: { loopback: {
            endpoint: { v: 1, routeKind: 'loopback_direct', url: 'http://127.0.0.1:46011',
                endpointFingerprint: 'endpoint_1', expiresAt: now + 600_000 },
        } } } } }, machineListByServerId: {} };
        let mints = 0;
        let admissionAvailable = true;
        const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            mints += 1;
            if (!admissionAvailable) return responseJson({ ok: false, reasonCode: 'access_denied' });
            const body = JSON.parse(String(init?.body)) as { ephemeralPublicKeyBase64Url: string };
            const grant = createDirectRequest().grant;
            return responseJson({ ok: true, grant: { ...grant, payload: { ...grant.payload,
                grantId: `grant-${mints}`, iat: Date.now(), exp: Date.now() + 60_000, callerAuthority: 'present_user',
                ephemeralPublicKeyBase64Url: body.ephemeralPublicKeyBase64Url } } });
        });
        vi.stubGlobal('fetch', fetchSpy);
        const route = await import('./productionRoute');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const resolve = () => route.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a', machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        });
        try {
            const initial = await Promise.all(Array.from({ length: 8 }, resolve));
            expect(initial.every(result => result.kind === 'selected')).toBe(true);
            expect(mints).toBe(1);
            expect(await resolve()).toMatchObject({ kind: 'selected', grant: { payload: { grantId: 'grant-1' } } });
            expect(mints).toBe(1);
            vi.mocked(Date.now).mockReturnValue(now + 60_000);
            expect(await resolve()).toMatchObject({ kind: 'selected', grant: { payload: { grantId: 'grant-2' } } });
            expect(mints).toBe(2);
            apiSocket.disconnect();
            expect(await resolve()).toMatchObject({ kind: 'selected', grant: { payload: { grantId: 'grant-3' } } });
            expect(mints).toBe(3);
            getCredentialsForServerUrlSpy.mockResolvedValue({ token: DATA_KEY_TOKEN, secret: Buffer.alloc(32, 7).toString('base64') });
            expect(await resolve()).toMatchObject({ kind: 'selected', grant: { payload: { grantId: 'grant-4' } } });
            expect(mints).toBe(4);
            admissionAvailable = false;
            expect(await resolve()).toMatchObject({ kind: 'selected', grant: { payload: { grantId: 'grant-4' } } });
            expect(mints).toBe(4);
            apiSocket.disconnect();
            expect(await resolve()).toMatchObject({ kind: 'fallback', reasonCode: 'access_denied' });
            expect(mints).toBe(5);
        } finally { apiSocket.disconnect(); vi.mocked(Date.now).mockRestore(); }
    });

    it('rejects an expired advertisement before minting a grant, even with fresh Machine presence', async () => {
        storageSnapshot.state = {
            machines: {
                machine_1: {
                    id: 'machine_1', active: true, activeAt: Date.now(),
                    daemonState: { peerMediation: { loopback: { endpoint: {
                        v: 1, routeKind: 'loopback_direct', url: 'http://127.0.0.1:46011',
                        endpointFingerprint: 'expired_endpoint', expiresAt: Date.now() - 1,
                    } } } },
                },
            },
            machineListByServerId: {},
        };
        // HTTP is the boundary; no route-grant request may be admitted for this topology.
        const fetchSpy = vi.fn(async () => { throw new Error('Unexpected grant request'); });
        vi.stubGlobal('fetch', fetchSpy);
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;

        await expect(module.resolveProductionMachineRpcDirectRoute({
            serverId: 'server-a', machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
        })).resolves.toMatchObject({ kind: 'fallback', reasonCode: 'topology_unavailable' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports absent current daemon topology without attempting authentication', async () => {
        storageSnapshot.state = { machines: {}, machineListByServerId: {} };
        getCredentialsForServerUrlSpy.mockResolvedValue({
            token: DATA_KEY_TOKEN,
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
            reasonCode: 'topology_unavailable',
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });


    it('fails closed to fallback when grant transport is unavailable', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46012',
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
        vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
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

    it('does not mint a grant when the target credential account changes after endpoint selection', async () => {
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46012',
            endpointFingerprint: 'endpoint_2',
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
        const replacementToken = 'header.eyJzdWIiOiJhY2NvdW50LTIifQ.signature';
        getCredentialsForServerUrlSpy
            .mockResolvedValueOnce({ token: TOKEN_A, secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64') })
            .mockResolvedValue({ token: replacementToken, secret: Buffer.from(new Uint8Array(32).fill(7)).toString('base64') });
        // Reachability is checked before the authenticated grant boundary.
        const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method === 'OPTIONS') return new Response(null, { status: 204 });
            throw new Error('Unexpected grant request');
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
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
        expect(fetchSpy.mock.calls.map(([, init]) => init?.method)).toEqual(['OPTIONS']);
    });


    it('forwards the caller abort signal to the direct loopback request', async () => {
        const controller = new AbortController();
        const entered = createDeferred<void>();
        let capturedSignal: AbortSignal | undefined;
        const fetchSpy = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
            capturedSignal = init?.signal ?? undefined;
            entered.resolve();
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                }, { once: true });
            });
        });
        vi.stubGlobal('fetch', fetchSpy);

        const module = await importProductionRoute();
        expect(module).toHaveProperty('postProductionMachineRpcDirect');
        if ('importError' in module) throw module.importError;

        const request = module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v1/machine-rpc',
            request: createDirectRequest(),
            signal: controller.signal,
        }).catch((error: unknown) => error);
        await entered.promise;
        controller.abort();
        const result = await request;

        // The caller signal must reach the actual request transport.
        expect(capturedSignal?.aborted).toBe(true);
        expect(readRpcRequestDisposition(result)).toBe('outcomeUnknown');
    });

    it.each([
        { status: 200, contentType: 'text/html', body: '<html>upstream unavailable: private-body</html>',
            bodyWasJson: false, rpcErrorCode: 'MACHINE_RPC_INVALID_RESPONSE', schemaIssues: [] },
        { status: 200, contentType: 'application/json', body: 'null', bodyWasJson: true,
            rpcErrorCode: 'MACHINE_RPC_INVALID_RESPONSE', schemaIssues: [{ code: 'invalid_type', path: [] }] },
        { status: 200, contentType: 'application/json', body: JSON.stringify({
            v: 2, ok: true, receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
            requestId: 7, method: RPC_METHODS.DAEMON_MEMORY_STATUS, routeKind: 'loopback_direct',
            result: { secret: 'private-body' },
        }), bodyWasJson: true, rpcErrorCode: 'MACHINE_RPC_INVALID_RESPONSE',
            schemaIssues: [{ code: 'invalid_type', path: ['requestId'] }] },
        { status: 502, contentType: 'text/html', body: '<html>Bad Gateway: private-body</html>',
            bodyWasJson: false, rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN, schemaIssues: [] },
        { status: 504, contentType: 'application/json', body: '{"error":"private-body"}',
            bodyWasJson: true, rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN, schemaIssues: [] },
    ])('retains safe direct-response diagnostics for HTTP $status / $contentType / JSON $bodyWasJson', async (vector) => {
        // HTTP is the boundary: exercise the real decoder and strict consumer.
        vi.stubGlobal('fetch', vi.fn(async () => new Response(vector.body, {
            status: vector.status, headers: { 'content-type': vector.contentType },
        })));
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        const error: unknown = await module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v2/rpc', request: createDirectRequest(),
        }).catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(RpcError);
        expect(error).toMatchObject({
            rpcErrorCode: vector.rpcErrorCode, httpStatus: vector.status, contentType: vector.contentType,
            bodyWasJson: vector.bodyWasJson, schemaIssues: vector.schemaIssues,
        });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
        // Neither arbitrary response data nor schema prose belongs in diagnostics.
        expect(JSON.stringify(error)).not.toContain('private-body');
        expect(String(error)).not.toContain('private-body');
    });

    it('requires a JSON content type even for a matching direct envelope', async () => {
        const payload = {
            v: 2, ok: true, receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
            requestId: 'request_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS, routeKind: 'loopback_direct',
            result: { ready: true },
        };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode(JSON.stringify(payload)))));
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        await expect(module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v2/rpc', request: createDirectRequest(),
        })).rejects.toMatchObject({ reasonCode: 'direct_response_content_type' });
    });

    it('preserves a direct body transport failure instead of treating it as malformed JSON', async () => {
        const failure = new TypeError('Connection terminated');
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
            start(controller) { controller.error(failure); },
        }), { headers: { 'content-type': 'application/json' } })));
        const module = await importProductionRoute();
        if ('importError' in module) throw module.importError;
        const error: unknown = await module.postProductionMachineRpcDirect({
            url: 'http://127.0.0.1:46021/peer-mediation/v2/rpc', request: createDirectRequest(),
        }).catch((cause: unknown) => cause);

        expect(error).toBe(failure);
        expect(error).toMatchObject({ httpStatus: 200, contentType: 'application/json', bodyWasJson: false });
        expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
    });

    it.each([
        { contentType: 'application/octet-stream', reasonCode: 'direct_response_content_type' },
        { contentType: 'application/json', body: '{"unrelated":true}', reasonCode: 'direct_response_invalid' },
        { contentType: 'application/json', requestId: 'other-request', reasonCode: 'direct_response_identity_mismatch' },
        { contentType: 'application/json', method: RPC_METHODS.CAPABILITIES_DESCRIBE, reasonCode: 'direct_response_identity_mismatch' },
    ])('uses one Home read after a non-identity direct response: $reasonCode', async (vector) => {
        const request = createDirectRequest();
        const fetchSpy = vi.fn(async () => new Response(vector.body ?? JSON.stringify({
            v: 2, ok: true, receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded,
            requestId: vector.requestId ?? request.requestId, method: vector.method ?? request.method,
            routeKind: 'loopback_direct', result: { from: 'wrong-machine' },
        }), { headers: { 'content-type': vector.contentType } }));
        vi.stubGlobal('fetch', fetchSpy);
        const { postProductionMachineRpcDirect } = await import('./productionRoute');
        const { machineRpcWithPeerMediationRoute } = await import('./client');
        const serverFallback = vi.fn(async () => ({ from: 'Home' }));
        const recordReceipt = vi.fn();
        await expect(machineRpcWithPeerMediationRoute({
            machineId: request.grant.payload.machineId, method: request.method, payload: request.params,
            createRequestId: () => request.requestId,
            resolveDirectRoute: async () => ({ kind: 'selected', receipt: PEER_MEDIATION_RECEIPTS.routeSelected,
                endpoint: { url: 'http://127.0.0.1:46021', endpointFingerprint: request.endpointFingerprint },
                grant: request.grant, proof: request.proof }),
            postDirect: postProductionMachineRpcDirect, serverFallback, recordReceipt,
        })).resolves.toEqual({ from: 'Home' });
        expect(fetchSpy).toHaveBeenCalledOnce();
        expect(serverFallback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reasonCode: vector.reasonCode }));
        expect(recordReceipt).toHaveBeenCalledWith(expect.objectContaining({ routeKind: 'server_relay', reasonCode: vector.reasonCode }));
    });

    it('aborts the direct loopback request when its timeout elapses', async () => {
        vi.useFakeTimers();
        try {
            let capturedSignal: AbortSignal | undefined;
            vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => (
                new Promise<Response>((_resolve, reject) => {
                    capturedSignal = init?.signal ?? undefined;
                    capturedSignal?.addEventListener('abort', () => {
                        reject(Object.assign(new Error('timed out'), { name: 'AbortError' }));
                    }, { once: true });
                })
            )));

            const module = await importProductionRoute();
            expect(module).toHaveProperty('postProductionMachineRpcDirect');
            if ('importError' in module) throw module.importError;

            const resultPromise = module.postProductionMachineRpcDirect({
                url: 'http://127.0.0.1:46021/peer-mediation/v1/machine-rpc',
                request: createDirectRequest(),
                timeoutMs: 5,
            }).catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(5);

            expect(capturedSignal?.aborted).toBe(true);
            expect(readRpcRequestDisposition(await resultPromise)).toBe('outcomeUnknown');
        } finally {
            vi.useRealTimers();
        }
    });
});
