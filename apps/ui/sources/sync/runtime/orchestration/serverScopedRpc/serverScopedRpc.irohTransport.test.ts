import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IrohError } from '@happier-dev/iroh-native';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import {
    adoptHomeProfile,
    getActiveServerSnapshot,
    resetServerProfilesRuntimeForTests,
    setActiveServerId,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { requestPeerRouteGrantV2 } from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import {
    peekServerReachabilityState,
    resetServerReachabilitySupervisors,
    setServerReachabilityNetworkAllowed,
} from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { disposeIrohHomeTunnelRuntime, getIrohHomeTunnelRuntime } from '@/sync/runtime/nativeIrohTunnels/runtime';
import type { IrohNativeLifecycleModule } from '@/sync/runtime/nativeIrohTunnels/supervisor';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createServerRequestWithServerScope } from './createServerRequestWithServerScope';
import { resetScopedSessionDataKeyCacheForTests } from './resolveScopedSessionDataKey';
import { resolveServerAccountRequestContext, ServerScopedTransportUnavailableError } from './resolveServerAccountRequestContext';
import { machineRpcWithServerScope } from './serverScopedMachineRpc';
import { resetScopedMachineTransportCacheForTests } from './serverScopedRpcPool';
import { serverScopedRpcSocketPool } from './serverScopedRpcSocketPool';
import { sessionRpcWithServerScope } from './serverScopedSessionRpc';

/**
 * Composed transport authority gate: a non-focused Iroh-only Home must serve scoped
 * HTTP and Socket.IO/RPC through its verified loopback runtime origin while stable
 * identity, auth audience, and reachability stay keyed by the canonical Home URL.
 * Fail-closed Iroh verification failures never degrade to another carrier; pure
 * availability failures may fall back only to a descriptor-proven HTTPS endpoint.
 */

const TOKEN_B = `hdr.${btoa(JSON.stringify({ sub: 'account-b' }))}.sig`;
const HOME_B_ID = 'srv_home_b';
const HOME_B_URL = 'http://127.0.0.1:3010';
const IROH_ENDPOINT_ID = 'b'.repeat(64);
const LEASE_RUNTIME_ORIGIN = 'http://127.0.0.1:43111';
const ioSpy = vi.hoisted(() => vi.fn());

// Socket.IO is the external network boundary; scoped transport and pool custody stay real.
vi.mock('socket.io-client', () => ({ io: (...args: unknown[]) => ioSpy(...args) }));

function nativeLease() {
    return {
        leaseId: 'lease-home-b', homeServerIdentityId: HOME_B_ID, homeEndpointId: IROH_ENDPOINT_ID,
        runtimeOrigin: LEASE_RUNTIME_ORIGIN, carrier: 'iroh' as const, observedPath: 'direct' as const, startedAtMs: 1,
    };
}

const ensureHomeTunnel = vi.fn<IrohNativeLifecycleModule['ensureHomeTunnel']>();
const releaseHomeTunnel = vi.fn<IrohNativeLifecycleModule['releaseHomeTunnel']>();
const operationFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const httpRequests: Array<{ url: string; authorization: string | null }> = [];

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function prepareHome(httpsEndpoint?: string): Promise<void> {
    await adoptHomeProfile({ source: 'qr', descriptor: {
        v: 1, homeServerIdentityId: HOME_B_ID, canonicalServerUrl: HOME_B_URL, revision: 3,
        endpoints: [
            { kind: 'iroh', endpointId: IROH_ENDPOINT_ID, relayUrls: ['https://relay.example.test'] },
            ...(httpsEndpoint ? [{ kind: 'https' as const, url: httpsEndpoint }] : []),
        ],
    } });
    // Real credential ownership/read/write/classification over the harness's OS storage boundaries.
    expect(await TokenStorage.setCredentialsForServerUrl(HOME_B_URL, { serverId: HOME_B_ID }, { token: TOKEN_B })).toBe(true);
    expect(getActiveServerSnapshot().serverUrl).toBe('https://home-a.example.test');
}

function expectHomeAudience(): void {
    expect(httpRequests).toContainEqual({ url: `${LEASE_RUNTIME_ORIGIN}/v1/auth/ping`, authorization: `Bearer ${TOKEN_B}` });
    expect(httpRequests.map(({ url }) => url)).toContain(`${LEASE_RUNTIME_ORIGIN}/v1/features`);
    expect(httpRequests.every(({ url }) => !url.startsWith(HOME_B_URL))).toBe(true);
}

describe('scoped transport authority for non-focused Iroh Homes', () => {
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `iroh_${crypto.randomUUID()}`;
        resetServerProfilesRuntimeForTests();
        resetServerFeaturesClientForTests();
        resetScopedSessionDataKeyCacheForTests();
        resetScopedMachineTransportCacheForTests();
        setServerReachabilityNetworkAllowed(true);
        ensureHomeTunnel.mockReset();
        ensureHomeTunnel.mockResolvedValue(nativeLease());
        releaseHomeTunnel.mockReset();
        releaseHomeTunnel.mockResolvedValue(undefined);
        operationFetch.mockReset();
        operationFetch.mockImplementation(async (url) => { throw new Error(`Unexpected Home operation: ${url}`); });
        ioSpy.mockReset();
        httpRequests.length = 0;
        // HTTP is external. Native adapter, probes, identity checks and reachability remain real.
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            httpRequests.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
            if (url === `${LEASE_RUNTIME_ORIGIN}/health` || url === `${LEASE_RUNTIME_ORIGIN}/v1/auth/ping`) return jsonResponse({});
            if (url === `${LEASE_RUNTIME_ORIGIN}/v1/features`) {
                return jsonResponse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: HOME_B_ID } } });
            }
            return await operationFetch(url, init);
        });
        getIrohHomeTunnelRuntime({ native: { ensureHomeTunnel, releaseHomeTunnel } });
        const focused = await upsertServerProfile({ serverUrl: 'https://home-a.example.test', name: 'Home A' });
        await setActiveServerId(focused.id);
    });

    afterEach(async () => {
        // Drain the physical socket's transferred carrier custody before disposing the native owner.
        await serverScopedRpcSocketPool.stopAll();
        await disposeIrohHomeTunnelRuntime();
        await resetServerReachabilitySupervisors();
        resetScopedSessionDataKeyCacheForTests();
        resetScopedMachineTransportCacheForTests();
        resetServerFeaturesClientForTests();
        resetServerProfilesRuntimeForTests();
        resetRuntimeFetch();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    it('resolves the scoped context with a verified Iroh runtime origin and release ownership', async () => {
        await prepareHome();
        const context = await resolveServerAccountRequestContext({ serverId: HOME_B_ID });
        expect(context.scope).toBe('scoped');
        if (context.scope !== 'scoped') throw new Error('expected scoped context');
        expect(context.targetServerId).toBe(HOME_B_ID);
        expect(context.targetServerUrl).toBe(HOME_B_URL);
        expect(context.targetAccountId).toBe('account-b');
        expect(context.encryption).toBeNull();
        expect(ensureHomeTunnel).toHaveBeenCalledWith({
            homeServerIdentityId: HOME_B_ID, endpointId: IROH_ENDPOINT_ID,
            policy: 'automatic', relayUrls: ['https://relay.example.test'], directAddresses: undefined,
        });
        expect(context.runtimeOrigin).toBe(LEASE_RUNTIME_ORIGIN);
        expect(context.carrier).toBe('iroh');
        expectHomeAudience();
        await Promise.all([context.release?.(), context.release?.()]);
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
    });

    it('fails closed when Iroh verification rejects the Home identity', async () => {
        await prepareHome();
        ensureHomeTunnel.mockResolvedValue({ ...nativeLease(), homeServerIdentityId: 'srv_wrong_home' });
        await expect(resolveServerAccountRequestContext({ serverId: HOME_B_ID }))
            .rejects.toMatchObject({ name: 'IrohError', code: 'identity_mismatch' });
        expect(httpRequests).toEqual([]);
        expect(releaseHomeTunnel).toHaveBeenCalledWith('lease-home-b');
    });

    it('reports typed transport unavailability when pure Iroh unavailability has no independent HTTPS ingress', async () => {
        await prepareHome();
        ensureHomeTunnel.mockRejectedValue(new IrohError('unavailable', 'Native transport unavailable'));
        await expect(resolveServerAccountRequestContext({ serverId: HOME_B_ID }))
            .rejects.toBeInstanceOf(ServerScopedTransportUnavailableError);
        expect(httpRequests).toEqual([]);
    });

    it('falls back to a descriptor-proven independent HTTPS endpoint after pure Iroh unavailability', async () => {
        await prepareHome(' HTTPS://Home-B.Example.test:443/api/// ');
        ensureHomeTunnel.mockRejectedValue(new IrohError('unavailable', 'Native transport unavailable'));
        const context = await resolveServerAccountRequestContext({ serverId: HOME_B_ID });
        if (context.scope !== 'scoped') throw new Error('expected scoped context');
        expect(context.targetServerUrl).toBe(HOME_B_URL);
        expect(context.targetAccountId).toBe('account-b');
        expect(context.runtimeOrigin).toBe('https://home-b.example.test/api');
        expect(context.carrier).toBe('https');
        await context.release?.();
        expect(releaseHomeTunnel).not.toHaveBeenCalled();
    });

    it('serves scoped session RPC for a non-focused Iroh-only Home through the verified loopback origin', async () => {
        await prepareHome();
        operationFetch.mockImplementation(async (url) => {
            if (url === `${LEASE_RUNTIME_ORIGIN}/v2/sessions/session-1`) return jsonResponse({ session: {
                id: 'session-1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                archivedAt: null, metadata: 'metadata', metadataVersion: 1, agentState: null,
                agentStateVersion: 0, pendingCount: 0, pendingVersion: 0, encryptionMode: 'plain', dataEncryptionKey: null,
            } });
            throw new Error(`Unexpected session request: ${url}`);
        });
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockResolvedValue({ ok: true, result: { watched: true } });
        ioSpy.mockReturnValue(socket);
        await expect(sessionRpcWithServerScope({
            sessionId: 'session-1', serverId: HOME_B_ID, method: 'session.permission.remote.grants.list',
            payload: { sessionId: 'session-1' }, timeoutMs: 5_000,
        })).resolves.toEqual({ watched: true });
        expectHomeAudience();
        expect(ioSpy).toHaveBeenCalledTimes(1);
        expect(ioSpy.mock.calls[0]?.[0]).toBe(LEASE_RUNTIME_ORIGIN);
        expect(peekServerReachabilityState(HOME_B_URL)?.phase).toBe('online');
        // Logical RPC completion leaves the pooled physical socket's native carrier alive.
        expect(releaseHomeTunnel).not.toHaveBeenCalled();
        await serverScopedRpcSocketPool.stopAll();
        expect(socket.connected).toBe(false);
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
    });

    it('serves scoped HTTP for a non-focused Iroh-only Home through the verified loopback origin', async () => {
        await prepareHome();
        const sourceResponse = jsonResponse({ ok: true });
        const readBodySpy = vi.spyOn(sourceResponse, 'arrayBuffer');
        operationFetch.mockImplementation(async (url) => {
            if (url === `${LEASE_RUNTIME_ORIGIN}/v1/example`) return sourceResponse;
            throw new Error(`Unexpected scoped HTTP request: ${url}`);
        });
        const request = createServerRequestWithServerScope({
            serverId: HOME_B_ID, activeRequest: async () => { throw new Error('non-focused HTTP must not use active request'); },
        });
        const response = await request('/v1/example', { method: 'GET' });
        expect(response.status).toBe(200);
        expect(readBodySpy).toHaveBeenCalledTimes(1);
        await expect(response.json()).resolves.toEqual({ ok: true });
        expectHomeAudience();
        expect(httpRequests).toContainEqual({ url: `${LEASE_RUNTIME_ORIGIN}/v1/example`, authorization: `Bearer ${TOKEN_B}` });
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
    });

    it('mints a peer-route grant for a non-focused Iroh-only Home through the verified loopback origin', async () => {
        await prepareHome();
        const clientEndpointId = 'a'.repeat(64);
        const machineEndpointId = 'b'.repeat(64);
        const ephemeralPublicKeyBase64Url = Buffer.from(new Uint8Array(32).fill(7)).toString('base64url');
        operationFetch.mockImplementation(async (url, init) => {
            if (url !== `${LEASE_RUNTIME_ORIGIN}/v1/machines/peer/mediation/route-grants`) throw new Error(`Unexpected grant request: ${url}`);
            expect(init?.method).toBe('POST');
            expect(JSON.parse(String(init?.body))).toMatchObject({ ephemeralPublicKeyBase64Url, machineId: 'machine-b', endpointFingerprint: machineEndpointId });
            return jsonResponse({ ok: true, grant: {
                payload: {
                    v: 2, grantId: 'grant-v2', accountId: 'account-b', machineId: 'machine-b',
                    flowKind: 'bounded_transfer', routeKind: 'iroh_peer', scope: { kind: 'bounded_transfer', mode: 'carrier' },
                    iat: 1_000, exp: 301_000, aud: 'happier-daemon-route-grant', endpointFingerprint: machineEndpointId,
                    proofKind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url,
                    iroh: {
                        initiator: { kind: 'account_client', endpointId: clientEndpointId },
                        target: { machineId: 'machine-b', endpointId: machineEndpointId }, operationKind: 'finite_transfer',
                    },
                },
                signature: { keyId: 'key-1', alg: 'Ed25519', valueBase64Url: Buffer.from(new Uint8Array(64).fill(4)).toString('base64url') },
            } });
        });
        const result = await requestPeerRouteGrantV2({
            authority: { request: createServerRequestWithServerScope({
                serverId: HOME_B_ID, activeRequest: async () => { throw new Error('non-focused grant must not use active request'); },
            }) },
            request: {
                v: 2, kind: 'ephemeral_ed25519', ephemeralPublicKeyBase64Url, machineId: 'machine-b',
                flowKind: 'bounded_transfer', routeKind: 'iroh_peer', endpointFingerprint: machineEndpointId,
                ttlMs: 300_000, scope: { kind: 'bounded_transfer', mode: 'carrier' },
                iroh: {
                    initiator: { kind: 'account_client', endpointId: clientEndpointId },
                    target: { machineId: 'machine-b', endpointId: machineEndpointId }, operationKind: 'finite_transfer',
                },
            }, timeoutMs: 5_000,
        });
        expect(result).toMatchObject({ ok: true, value: { payload: { grantId: 'grant-v2', accountId: 'account-b', ephemeralPublicKeyBase64Url } } });
        expectHomeAudience();
        expect(httpRequests).toContainEqual({ url: `${LEASE_RUNTIME_ORIGIN}/v1/machines/peer/mediation/route-grants`, authorization: `Bearer ${TOKEN_B}` });
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
    });

    it('releases the Iroh lease when machine preparation fails before socket acquisition', async () => {
        await prepareHome();
        operationFetch.mockImplementation(async (url) => {
            if (url === `${LEASE_RUNTIME_ORIGIN}/v1/machines/machine-1`) return jsonResponse({ machine: null });
            throw new Error(`Unexpected machine request: ${url}`);
        });
        const onIssued = vi.fn();
        await expect(machineRpcWithServerScope({
            serverId: HOME_B_ID, machineId: 'machine-1', method: 'machine.test', payload: {}, timeoutMs: 5_000, onIssued,
        })).rejects.toThrow('Machine encryption not found');
        expectHomeAudience();
        expect(ioSpy).not.toHaveBeenCalled();
        expect(onIssued).not.toHaveBeenCalled();
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
    });

    it('releases the Iroh lease when the caller aborts during scoped context acquisition', async () => {
        await prepareHome();
        const controller = new AbortController();
        let allocationEntered!: () => void;
        const entered = new Promise<void>((resolve) => { allocationEntered = resolve; });
        let completeAllocation!: (lease: ReturnType<typeof nativeLease>) => void;
        const allocated = new Promise<ReturnType<typeof nativeLease>>((resolve) => { completeAllocation = resolve; });
        let released!: () => void;
        const releaseCompleted = new Promise<void>((resolve) => { released = resolve; });
        ensureHomeTunnel.mockImplementation(async () => { allocationEntered(); return await allocated; });
        releaseHomeTunnel.mockImplementation(async () => { released(); });
        const onIssued = vi.fn();
        const request = machineRpcWithServerScope({
            serverId: HOME_B_ID, machineId: 'machine-1', method: 'machine.test', payload: {}, timeoutMs: 5_000,
            signal: controller.signal, onIssued,
        });
        const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        await entered;
        controller.abort();
        completeAllocation(nativeLease());
        await rejection;
        // The caller fence can settle first; the real late context still must release its native lease.
        await releaseCompleted;
        expectHomeAudience();
        expect(ioSpy).not.toHaveBeenCalled();
        expect(onIssued).not.toHaveBeenCalled();
        expect(releaseHomeTunnel).toHaveBeenCalledTimes(1);
    });
});
