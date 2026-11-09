import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { MachinePublishedDaemonStateV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { DirectRouteGrantRequestV2Schema, SignedDirectRouteGrantV2Schema,
    type DirectRouteGrantRequestV2 } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { PeerLoopbackEndpointCandidateV1Schema } from '@happier-dev/protocol/machines/peer/mediation/loopbackEndpointV1';
import { PEER_MEDIATION_RECEIPTS } from '@happier-dev/protocol/machines/peer/mediation/receipts';
import { PEER_MACHINE_RPC_DIRECT_PATH_V2, PeerMachineRpcDirectRequestV2Schema,
    PeerMachineRpcDirectResponseV2Schema, type PeerMachineRpcDirectRequestV2 } from '@happier-dev/protocol/machines/peer/mediation/rpc/directV2';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonPluginUiTargetedContributionsReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { createPlainMachineRowFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Home admission, the applied Account lifetime, route policy/proofs and the RPC
// client remain real. Only Home HTTP/Socket.IO and daemon HTTP are replaced.
const boundary = await installSessionOpsNetworkBoundary();
// The desktop command bridge is the OS boundary. Publish its already observed
// status through the real shared owner so the direct route has same-host proof.
vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
const { publishLocalDaemonStatus } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
const { machineRpcWithServerScope, createOrderedMachineRpcCaller } = await import('./serverScopedMachineRpc');
const { resetScopedMachineTransportCacheForTests } = await import('./serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { clearMachineRpcPeerMediationReceiptsForTest, getMachineRpcPeerMediationReceiptsSnapshot } = await import('@/sync/domains/machines/peer/mediation/rpc/receiptLog');
const { getStorage } = await import('@/sync/domains/state/storageStore');

const grantRequests: DirectRouteGrantRequestV2[] = [];
const directRequests: PeerMachineRpcDirectRequestV2[] = [];
const directSignals: Array<AbortSignal | null | undefined> = [];
const directResponses: Promise<Response>[] = [];
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let prepareGrant = async (_request: DirectRouteGrantRequestV2): Promise<void> => {};
let directReply = async (request: PeerMachineRpcDirectRequestV2): Promise<unknown> => request.params;
let directRefusal = false;
let directEnabled = true;
let fallbackHomeReads = 0;
let nonIdentityResponse = false;

function createDeclarationReply(pluginId = 'example.target') {
    return DaemonPluginUiTargetedContributionsReadResponseSchema.parse({
        status: 'sourceDeclarations', pluginId,
        sourceDeclarations: Array.from({ length: 10 }, (_, index) => ({
            manifest: { id: `example.source-${index}`, contributes: {
                actions: [], pluginContributionPoints: [], ui: { renderers: [] },
                targetedPluginContributions: [{ id: 'source', target: { pluginId, pointId: 'sources' },
                    protocol: { id: 'example-sources', version: 1 }, descriptor: {}, operations: {} }],
            } }, occurrenceId: `source-${index}`, sourceCustody: { kind: 'development', registeredRootId: `source-${index}` },
        })),
    });
}

afterAll(() => boundary.dispose());

describe('machineRpcWithServerScope signal (direct peer route)', () => {
    beforeEach(async () => {
        boundary.resetRequests();
        // Retained Machine reads (Action schemas, source declarations) belong to one case.
        (await import('@/sync/ops/machineContributionRegistryProjection')).resetMachineProjectionReadsForTests();
        resetScopedMachineTransportCacheForTests();
        resetServerFeaturesClientForTests();
        clearMachineRequestReachabilityForTest();
        clearMachineRpcPeerMediationReceiptsForTest();
        grantRequests.length = 0;
        directRequests.length = 0;
        directSignals.length = 0;
        directResponses.length = 0;
        prepareGrant = async () => {};
        directReply = async (request) => request.params;
        directRefusal = false;
        directEnabled = true;
        fallbackHomeReads = 0;
        nonIdentityResponse = false;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: vi.fn() });
        const home = await boundary.addHome('https://server-a.example.test', 'account_1');
        publishLocalDaemonStatus(getSystemTasksRunner(), {
            machineId: 'machine_1', daemonAccountId: home.accountId, daemonServerUrl: home.serverUrl,
        });
        const endpoint = PeerLoopbackEndpointCandidateV1Schema.parse({
            v: 1, routeKind: 'loopback_direct', url: 'http://127.0.0.1:3000',
            endpointFingerprint: 'endpoint_1', expiresAt: Date.now() + 300_000,
        });
        const machineRow = {
            ...createPlainMachineRowFixture({ id: 'machine_1', accountId: home.accountId }),
            daemonState: encodePlainMachineStoredContent(MachinePublishedDaemonStateV1Schema.parse({
                status: 'running', peerMediation: { loopback: { endpoint } },
            })),
        };
        boundary.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
                id => id === machineRow.id ? machineRow : null);
            if (path === '/v1/machines') return Response.json([machineRow]);
            if (path === '/v1/machines/machine_1') return Response.json({ machine: machineRow });
            if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                features: { machines: { enabled: true, rpc: { enabled: true, directPeer: { enabled: directEnabled } } } },
                capabilities: {},
            }));
            if (path !== '/v1/machines/peer/mediation/route-grants') return null;
            // Consume the real client's request and mint the boundary response
            // from that exact ephemeral key, scope and endpoint binding.
            const request = DirectRouteGrantRequestV2Schema.parse(JSON.parse(String(init?.body)));
            grantRequests.push(request);
            await prepareGrant(request);
            const now = Date.now();
            return Response.json({ ok: true, grant: SignedDirectRouteGrantV2Schema.parse({
                payload: {
                    v: 2, grantId: `grant_${grantRequests.length}`, accountId: home.accountId,
                    machineId: request.machineId, flowKind: request.flowKind, routeKind: request.routeKind,
                    scope: request.scope, iat: now, exp: now + request.ttlMs, aud: 'happier-daemon-route-grant',
                    endpointFingerprint: request.endpointFingerprint, proofKind: 'ephemeral_ed25519',
                    ephemeralPublicKeyBase64Url: request.ephemeralPublicKeyBase64Url,
                },
                signature: { keyId: 'key_1', alg: 'Ed25519',
                    valueBase64Url: Buffer.from(new Uint8Array(64).fill(2)).toString('base64url') },
            }) });
        });
        vi.stubGlobal('fetch', vi.fn<typeof fetch>((input, init) => {
            const url = new URL(String(input));
            if (directRefusal && url.origin === home.serverUrl && url.pathname === '/v1/features') {
                fallbackHomeReads++;
                return Promise.resolve(Response.json({ error: 'Home unavailable' }, { status: 503 }));
            }
            expect(url.origin).toBe(endpoint.url);
            expect(url.pathname).toBe(PEER_MACHINE_RPC_DIRECT_PATH_V2);
            if (init?.method === 'OPTIONS') return Promise.resolve(new Response(null, { status: 204 }));
            expect(init?.method).toBe('POST');
            const request = PeerMachineRpcDirectRequestV2Schema.parse(JSON.parse(String(init?.body)));
            directRequests.push(request);
            directSignals.push(init?.signal);
            if (nonIdentityResponse) return Promise.resolve(new Response('unrelated listener', {
                headers: { 'content-type': 'application/octet-stream' },
            }));
            const response = directReply(request).then(result => Response.json(PeerMachineRpcDirectResponseV2Schema.parse(directRefusal ? {
                v: 2, ok: false, requestId: request.requestId, method: request.method,
                receipt: PEER_MEDIATION_RECEIPTS.rpcFellBackToServer, reasonCode: 'grant_invalid',
            } : {
                v: 2, ok: true, requestId: request.requestId, method: request.method,
                receipt: PEER_MEDIATION_RECEIPTS.rpcDirectCallSucceeded, routeKind: 'loopback_direct', result,
            })));
            directResponses.push(response);
            return response;
        }));
        account = await restoreServerAccountForTest({
            serverUrl: home.serverUrl, accountId: home.accountId, request: boundary.request,
        });
        // Bootstrap and later refreshes must hydrate the same advertised
        // topology through the real stored-content reader.
        const { sync } = await import('@/sync/sync');
        await sync.refreshMachines();
        expect(getStorage().getState().machines.machine_1?.daemonState?.peerMediation?.loopback?.endpoint).toEqual(endpoint);
    });

    afterEach(async () => {
        await account?.dispose();
        account = undefined;
        await serverScopedRpcSocketPool.stopAll();
        await resetServerReachabilitySupervisors();
        publishLocalDaemonStatus(getSystemTasksRunner(), null);
        vi.unstubAllGlobals();
    });

    it('uses the real Home baseline with zero direct requests when loopback locality is unproven', async () => {
        publishLocalDaemonStatus(getSystemTasksRunner(), null);
        boundary.setRpcResponder(async () => ({ from: 'Home' }));
        await expect(machineRpcWithServerScope({ machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: {} })).resolves.toEqual({ from: 'Home' });
        expect(directRequests).toEqual([]);
        expect(grantRequests).toEqual([]);
        expect(boundary.requests).toHaveLength(1);
        expect(getMachineRpcPeerMediationReceiptsSnapshot()).toEqual(expect.arrayContaining([
            expect.objectContaining({ reasonCode: 'loopback_locality_unproven', routeKind: 'server_relay' }),
        ]));
    });

    it('recovers a non-identity direct read through one real Home baseline request', async () => {
        nonIdentityResponse = true;
        boundary.setRpcResponder(async () => ({ from: 'Home' }));
        await expect(machineRpcWithServerScope({ machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: {} })).resolves.toEqual({ from: 'Home' });
        expect(directRequests).toHaveLength(1);
        expect(boundary.requests).toHaveLength(1);
        expect(getMachineRpcPeerMediationReceiptsSnapshot()).toEqual(expect.arrayContaining([
            expect.objectContaining({ reasonCode: 'direct_response_content_type', routeKind: 'server_relay' }),
        ]));
    });

    it('orders delayed route preparation while keeping recognition replies concurrently in flight', async () => {
        const routeReady = createDeferred<void>();
        prepareGrant = async () => { await routeReady.promise; };
        const replies = [createDeferred<unknown>(), createDeferred<unknown>()];
        directReply = async (request) => {
            const { seq } = request.params as { seq: number };
            return await replies[seq]!.promise;
        };
        const call = createOrderedMachineRpcCaller();
        const first = call({ machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS, payload: { seq: 0 } });
        const second = call({ machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS, payload: { seq: 1 } });
        const settled = Promise.allSettled([first, second]);
        try {
            await vi.waitFor(() => expect(grantRequests).toHaveLength(1));
            expect(directRequests).toEqual([]);
            routeReady.resolve();
            await vi.waitFor(() => expect(directRequests.map(request => request.params)).toEqual([{ seq: 0 }, { seq: 1 }]));
            // A reply fence would leave only seq 0 dispatched at this point.
            replies[1]!.resolve({ ackSeq: 1 });
            replies[0]!.resolve({ ackSeq: 0 });
            await expect(second).resolves.toEqual({ ackSeq: 1 });
            await expect(first).resolves.toEqual({ ackSeq: 0 });
            expect(boundary.requests).toEqual([]);
        } finally {
            routeReady.resolve();
            replies.forEach(reply => reply.resolve(null));
            await settled;
        }
    });

    it('shares an admitted active projection and retains its acknowledgement after the first borrower retires', async () => {
        const { machineContributionRegistryProjectionDescribe } = await import('@/sync/ops/machineContributionRegistryProjection');
        const { userRequestLeaseOwner } = await import('@/sync/runtime/connectivity/userRequestLease');
        const reply = createDeferred<unknown>();
        boundary.setRpcResponder(async () => await reply.promise);
        const abort = new AbortController();
        const input = { serverId: account!.home.id };
        const beforeCredentialReads = boundary.credentialRequests.length;
        const first = machineContributionRegistryProjectionDescribe('machine_1', { ...input, signal: abort.signal });
        const survivor = machineContributionRegistryProjectionDescribe('machine_1', input);
        const settled = Promise.allSettled([first, survivor]);
        const routineTeardown = vi.fn();
        try {
            await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
            abort.abort();
            await expect(first).resolves.toEqual({ supported: false, reason: 'aborted' });
            expect(userRequestLeaseOwner.deferRoutineTeardown(routineTeardown)).toBe(true);
            expect(routineTeardown).not.toHaveBeenCalled();
            reply.resolve({ protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {} } });
            await expect(survivor).resolves.toMatchObject({ supported: true });
            expect(boundary.requests).toHaveLength(1);
            expect(boundary.requests[0]?.token).toBe(account!.credentials.token);
            // The installed active socket admits this row locally; a scoped
            // fallback would have to acquire saved credentials again.
            expect(boundary.credentialRequests).toHaveLength(beforeCredentialReads);
            expect(directRequests).toEqual([]);
            expect(grantRequests).toEqual([]);
            expect(routineTeardown).toHaveBeenCalledOnce();
        } finally {
            userRequestLeaseOwner.cancelDeferredRoutineTeardown();
            reply.resolve(null);
            await settled;
        }
    });

    it('shares seven admitted direct projection reads without retaining a settled result', async () => {
        const { createMachineRpcReadAdmission } = await import('./machineRpcReadAdmission');
        const reply = createDeferred<unknown>();
        directReply = async () => await reply.promise;
        const payload = { machineId: 'machine_1', pluginId: 'example.target', readMode: 'sourceDeclarations' };
        const readAdmission = createMachineRpcReadAdmission(['targeted-source-declarations', payload]);
        const onDispatched = vi.fn();
        const abort = new AbortController();
        const call = (signal?: AbortSignal) => machineRpcWithServerScope({
            machineId: 'machine_1', method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
            payload, readAdmission, onDispatched, signal,
        });
        const first = call(abort.signal);
        const survivors = Array.from({ length: 6 }, () => call());
        const settled = Promise.allSettled([first, ...survivors]);
        try {
            // Every borrower still obtains its own Home admission. Issuance is
            // the barrier, not a wall-time performance threshold.
            await vi.waitFor(() => expect(onDispatched).toHaveBeenCalledTimes(7));
            expect(grantRequests).toHaveLength(7);
            expect(new Set(grantRequests.map(request => request.ephemeralPublicKeyBase64Url)).size).toBe(7);
            expect(directRequests).toHaveLength(1);
            abort.abort();
            await expect(first).rejects.toMatchObject({ code: 'MACHINE_RPC_ABORTED' });
            expect(directSignals[0]?.aborted).toBe(false);
            reply.resolve({ contributions: [] });
            await expect(Promise.all(survivors)).resolves.toEqual(Array.from({ length: 6 }, () => ({ contributions: [] })));
            await expect(call()).resolves.toEqual({ contributions: [] });
            expect(directRequests).toHaveLength(2);
            expect(boundary.requests).toEqual([]);
        } finally {
            reply.resolve(null);
            await settled;
        }
    });

    it.each(['direct', 'active relay', 'scoped relay'] as const)('decodes one physical declaration reply once for concurrent public readers over %s', async route => {
        const { machinePluginTargetedSourceDeclarationsRead } = await import('@/sync/ops/machineContributionRegistryProjection');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        if (route !== 'direct') { directEnabled = false; resetServerFeaturesClientForTests(); }
        const reply = createDeferred<void>();
        const response = createDeclarationReply();
        directReply = async () => { await reply.promise; return response; };
        boundary.setRpcResponder(async () => { await reply.promise; return response; });
        // Forward the real schema parser: this counts complete ingress walks,
        // not a mocked decoder or an incidental transport-envelope check.
        const parses = vi.spyOn(DaemonPluginUiTargetedContributionsReadResponseSchema, 'safeParse');
        const call = () => machinePluginTargetedSourceDeclarationsRead('machine_1', {
            serverId: account!.home.id, pluginId: 'example.target', signal: new AbortController().signal,
            ...(route === 'scoped relay' ? { accountLifetime: captureActiveServerAccountScopeLifetime() } : {}),
        });
        const calls = [call(), call()];
        const settled = Promise.allSettled(calls);
        try {
            await vi.waitFor(() => expect(getMachineRpcPeerMediationReceiptsSnapshot().filter(
                receipt => receipt.receipt === (route === 'direct' ? PEER_MEDIATION_RECEIPTS.routeSelected : PEER_MEDIATION_RECEIPTS.routeFallback),
            )).toHaveLength(2));
            await vi.waitFor(() => expect(route === 'direct' ? directRequests : boundary.requests).toHaveLength(1));
            reply.resolve();
            expect(await Promise.all(calls)).toEqual(Array.from({ length: 2 }, () => ({
                supported: true, sourceDeclarations: response.status === 'sourceDeclarations' ? response.sourceDeclarations : [],
            })));
            expect(parses).toHaveBeenCalledTimes(1);
            expect(route === 'direct' ? boundary.requests : directRequests).toEqual([]);
            // A settled answer is kept for the Machine's current projection revision.
            await expect(call()).resolves.toMatchObject({ supported: true });
            expect(route === 'direct' ? directRequests : boundary.requests).toHaveLength(1);
            expect(parses).toHaveBeenCalledTimes(1);
            // A registry change advances that revision; the next reader decodes one fresh reply.
            const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjection');
            publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine_1', serverId: account!.home.id }, 'authority');
            await expect(call()).resolves.toMatchObject({ supported: true });
            expect(route === 'direct' ? directRequests : boundary.requests).toHaveLength(2);
            expect(parses).toHaveBeenCalledTimes(2);
        } finally {
            reply.resolve();
            await settled;
            parses.mockRestore();
        }
    });

    it.each([
        { name: 'wrong target', response: { status: 'sourceDeclarations', pluginId: 'example.other', sourceDeclarations: [] }, reason: 'invalid-response', parses: 1 },
        { name: 'invalid response', response: null, reason: 'invalid-response', parses: 1 },
        { name: 'missing method', response: { error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }, reason: 'not-supported', parses: 0 },
        { name: 'unavailable', response: { status: 'unavailable', code: 'plugin_targeted_contributions_unavailable' }, reason: 'unavailable', parses: 1 },
    ])('preserves $name declaration refusals after a shared physical decode', async control => {
        const { machinePluginTargetedSourceDeclarationsRead } = await import('@/sync/ops/machineContributionRegistryProjection');
        const reply = createDeferred<void>();
        directReply = async () => { await reply.promise; return control.response; };
        const parses = vi.spyOn(DaemonPluginUiTargetedContributionsReadResponseSchema, 'safeParse');
        const calls = Array.from({ length: 2 }, () => machinePluginTargetedSourceDeclarationsRead('machine_1', {
            serverId: account!.home.id, pluginId: 'example.target',
        }));
        const settled = Promise.allSettled(calls);
        try {
            await vi.waitFor(() => expect(getMachineRpcPeerMediationReceiptsSnapshot().filter(
                receipt => receipt.receipt === PEER_MEDIATION_RECEIPTS.routeSelected,
            )).toHaveLength(2));
            expect(directRequests).toHaveLength(1);
            reply.resolve();
            expect(await Promise.all(calls)).toEqual(Array.from({ length: 2 }, () => ({
                supported: false, reason: control.reason,
                ...(control.reason === 'unavailable' ? { code: 'plugin_targeted_contributions_unavailable' } : {}),
            })));
            expect(parses).toHaveBeenCalledTimes(control.parses);
        } finally { reply.resolve(); await settled; parses.mockRestore(); }
    });

    it.each(['direct', 'relay'] as const)('decodes one normal targeted snapshot for concurrent public readers over %s', async route => {
        const { machinePluginUiTargetedContributionsRead } = await import('@/sync/ops/machineContributionRegistryProjection');
        if (route === 'relay') { directEnabled = false; resetServerFeaturesClientForTests(); }
        const response = DaemonPluginUiTargetedContributionsReadResponseSchema.parse({
            status: 'current', targetedContributions: { target: {
                pluginId: 'example.target', occurrenceId: 'target-current',
                sourceCustody: { kind: 'development', registeredRootId: 'target-root' },
            }, points: [] }, targetedSurfaceMounts: [],
        });
        const reply = createDeferred<void>();
        directReply = async () => { await reply.promise; return response; };
        boundary.setRpcResponder(async () => { await reply.promise; return response; });
        const parses = vi.spyOn(DaemonPluginUiTargetedContributionsReadResponseSchema, 'safeParse');
        const calls = Array.from({ length: 2 }, () => machinePluginUiTargetedContributionsRead('machine_1', {
            serverId: account!.home.id, pluginId: 'example.target',
        }));
        const settled = Promise.allSettled(calls);
        try {
            await vi.waitFor(() => expect(getMachineRpcPeerMediationReceiptsSnapshot().filter(
                receipt => receipt.receipt === (route === 'direct' ? PEER_MEDIATION_RECEIPTS.routeSelected : PEER_MEDIATION_RECEIPTS.routeFallback),
            )).toHaveLength(2));
            await vi.waitFor(() => expect(route === 'direct' ? directRequests : boundary.requests).toHaveLength(1));
            reply.resolve();
            for (const result of await Promise.all(calls)) expect(result).toMatchObject({ supported: true,
                targetedContributions: { target: { pluginId: 'example.target', occurrenceId: 'target-current' } }, targetedSurfaceMounts: [],
            });
            expect(parses).toHaveBeenCalledTimes(1);
        } finally { reply.resolve(); await settled; parses.mockRestore(); }
    });

    it('decodes the surviving public declaration read after another borrower cancels', async () => {
        const { machinePluginTargetedSourceDeclarationsRead } = await import('@/sync/ops/machineContributionRegistryProjection');
        const response = createDeclarationReply();
        const reply = createDeferred<void>();
        directReply = async () => { await reply.promise; return response; };
        const parses = vi.spyOn(DaemonPluginUiTargetedContributionsReadResponseSchema, 'safeParse');
        const abort = new AbortController();
        const input = { serverId: account!.home.id, pluginId: 'example.target' };
        const cancelled = machinePluginTargetedSourceDeclarationsRead('machine_1', { ...input, signal: abort.signal });
        const survivor = machinePluginTargetedSourceDeclarationsRead('machine_1', input);
        const settled = Promise.allSettled([cancelled, survivor]);
        try {
            await vi.waitFor(() => expect(getMachineRpcPeerMediationReceiptsSnapshot().filter(
                receipt => receipt.receipt === PEER_MEDIATION_RECEIPTS.routeSelected,
            )).toHaveLength(2));
            expect(directRequests).toHaveLength(1);
            abort.abort();
            await expect(cancelled).resolves.toEqual({ supported: false, reason: 'aborted' });
            expect(directSignals[0]?.aborted).toBe(false);
            reply.resolve();
            await expect(survivor).resolves.toMatchObject({ supported: true, sourceDeclarations: expect.any(Array) });
            expect(parses).toHaveBeenCalledTimes(1);
        } finally { reply.resolve(); await settled; parses.mockRestore(); }
    });

    it('decodes only the eventual relay reply after a direct no-effect refusal', async () => {
        const { machinePluginTargetedSourceDeclarationsRead } = await import('@/sync/ops/machineContributionRegistryProjection');
        const response = createDeclarationReply();
        directRefusal = true;
        boundary.setRpcResponder(async () => response);
        const parses = vi.spyOn(DaemonPluginUiTargetedContributionsReadResponseSchema, 'safeParse');
        try {
            await expect(machinePluginTargetedSourceDeclarationsRead('machine_1', {
                serverId: account!.home.id, pluginId: 'example.target',
            })).resolves.toMatchObject({ supported: true });
            expect(directRequests).toHaveLength(1);
            expect(boundary.requests).toHaveLength(1);
            expect(parses).toHaveBeenCalledTimes(1);
        } finally { parses.mockRestore(); }
    });

    it.each(['no admission', 'finite', 'explicit identity'] as const)('decodes each independent %s direct response once', async kind => {
        const { createMachineRpcReadAdmission } = await import('./machineRpcReadAdmission');
        const reply = createDeferred<void>();
        directReply = async () => { await reply.promise; return { raw: true }; };
        const decodeResult = vi.fn((value: unknown) => ({ decoded: value }));
        const readAdmission = createMachineRpcReadAdmission(['independent-decoded-read']);
        const calls = [0, 1].map(index => machineRpcWithServerScope({
            machineId: 'machine_1', method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
            payload: {}, decodeResult,
            ...(kind === 'no admission' ? {} : { readAdmission }),
            ...(kind === 'finite' ? { timeoutMs: 30_000 } : kind === 'explicit identity' ? { requestId: `independent-${index}` } : {}),
        }));
        const settled = Promise.allSettled(calls);
        try {
            await vi.waitFor(() => expect(directRequests).toHaveLength(2));
            reply.resolve();
            expect(await Promise.all(calls)).toEqual([{ decoded: { raw: true } }, { decoded: { raw: true } }]);
            expect(decodeResult).toHaveBeenCalledTimes(2);
        } finally { reply.resolve(); await settled; }
    });

    it.each(['direct', 'relay'] as const)('partitions raw and differently decoded pending results over %s', async route => {
        const { createMachineRpcReadAdmission } = await import('./machineRpcReadAdmission');
        if (route === 'relay') { directEnabled = false; resetServerFeaturesClientForTests(); }
        const reply = createDeferred<void>();
        directReply = async () => { await reply.promise; return { raw: true }; };
        boundary.setRpcResponder(async () => { await reply.promise; return { raw: true }; });
        const firstDecoder = vi.fn((value: unknown) => ({ first: value }));
        const secondDecoder = vi.fn((value: unknown) => ({ second: value }));
        const input = { machineId: 'machine_1', method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
            payload: {}, readAdmission: createMachineRpcReadAdmission(['decoded-read-partitions']) };
        const calls = [machineRpcWithServerScope(input), machineRpcWithServerScope({ ...input, decodeResult: firstDecoder }),
            machineRpcWithServerScope({ ...input, decodeResult: firstDecoder }), machineRpcWithServerScope({ ...input, decodeResult: secondDecoder })];
        const settled = Promise.allSettled(calls);
        try {
            await vi.waitFor(() => expect(getMachineRpcPeerMediationReceiptsSnapshot().filter(
                receipt => receipt.receipt === (route === 'direct' ? PEER_MEDIATION_RECEIPTS.routeSelected : PEER_MEDIATION_RECEIPTS.routeFallback),
            )).toHaveLength(4));
            await vi.waitFor(() => expect(route === 'direct' ? directRequests : boundary.requests).toHaveLength(3));
            reply.resolve();
            expect(await Promise.all(calls)).toEqual([{ raw: true }, { first: { raw: true } }, { first: { raw: true } }, { second: { raw: true } }]);
            expect(firstDecoder).toHaveBeenCalledTimes(1);
            expect(secondDecoder).toHaveBeenCalledTimes(1);
        } finally { reply.resolve(); await settled; }
    });

    it('keeps different direct read questions independent under the same Account authority', async () => {
        const { createMachineRpcReadAdmission } = await import('./machineRpcReadAdmission');
        const reply = createDeferred<unknown>();
        directReply = async (request) => { await reply.promise; return request.params; };
        const calls = ['example.first', 'example.second'].map(pluginId => {
            const payload = { machineId: 'machine_1', pluginId, readMode: 'sourceDeclarations' };
            return machineRpcWithServerScope({ machineId: 'machine_1',
                method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ,
                payload, readAdmission: createMachineRpcReadAdmission(['targeted-source-declarations', payload]) });
        });
        const settled = Promise.allSettled(calls);
        try {
            await vi.waitFor(() => expect(directRequests).toHaveLength(2));
            reply.resolve(null);
            await expect(Promise.all(calls)).resolves.toEqual(['example.first', 'example.second'].map(pluginId => ({
                machineId: 'machine_1', pluginId, readMode: 'sourceDeclarations',
            })));
        } finally { reply.resolve(null); await settled; }
    });

    it('retains the domain Action schema at the existing read-admission owner on direct transport', async () => {
        const { machinePluginActionSchemasRead, resetMachineProjectionReadsForTests } = await import('@/sync/ops/machineContributionRegistryProjection');
        const result = { ok: true, inputSchema: { type: 'object' } };
        directReply = async () => result;
        const request = { serverId: account!.home.id, expectedOccurrenceId: 'occurrence_1', qualifiedActionId: 'example.target/inspect' };
        try {
            await expect(machinePluginActionSchemasRead('machine_1', request)).resolves.toEqual({ supported: true, result });
            await expect(machinePluginActionSchemasRead('machine_1', request)).resolves.toEqual({ supported: true, result });
            expect(directRequests).toHaveLength(1);
            expect(boundary.requests).toEqual([]);
        } finally { resetMachineProjectionReadsForTests(); }
    });

    it('withholds a shared direct result after its captured Account authority retires', async () => {
        const { createMachineRpcReadAdmission } = await import('./machineRpcReadAdmission');
        const reply = createDeferred<unknown>();
        directReply = async () => await reply.promise;
        const onDispatched = vi.fn();
        const payload = { machineId: 'machine_1', pluginId: 'example.target', readMode: 'sourceDeclarations' };
        const readAdmission = createMachineRpcReadAdmission(['targeted-source-declarations', payload]);
        const decodeResult = (value: unknown) => value;
        const calls = Array.from({ length: 2 }, () => machineRpcWithServerScope({ machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ, payload, readAdmission, decodeResult, onDispatched }));
        const settled = Promise.allSettled(calls);
        try {
            await vi.waitFor(() => expect(onDispatched).toHaveBeenCalledTimes(2));
            expect(directRequests).toHaveLength(1);
            await account!.dispose();
            account = undefined;
            reply.resolve({ contributions: [] });
            expect(await settled).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ status: 'rejected',
                reason: expect.objectContaining({ rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' }) })));
        } finally { reply.resolve(null); await settled; }
    });

    it('does not start relay fallback for a shared refusal after Account retirement', async () => {
        const { createMachineRpcReadAdmission } = await import('./machineRpcReadAdmission');
        const reply = createDeferred<unknown>();
        directReply = async () => await reply.promise;
        directRefusal = true;
        const onDispatched = vi.fn();
        const payload = { machineId: 'machine_1', pluginId: 'example.target', readMode: 'sourceDeclarations' };
        const readAdmission = createMachineRpcReadAdmission(['targeted-source-declarations', payload]);
        const decodeResult = vi.fn((value: unknown) => value);
        const calls = Array.from({ length: 2 }, () => machineRpcWithServerScope({ machineId: 'machine_1',
            method: RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ, payload, readAdmission, decodeResult, onDispatched }));
        const settled = Promise.allSettled(calls);
        try {
            await vi.waitFor(() => expect(onDispatched).toHaveBeenCalledTimes(2));
            expect(directRequests).toHaveLength(1);
            await account!.dispose();
            account = undefined;
            reply.resolve(null);
            const results = await settled;
            expect(fallbackHomeReads).toBe(0);
            expect(decodeResult).not.toHaveBeenCalled();
            expect(results).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ status: 'rejected',
                reason: expect.objectContaining({ rpcErrorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' }) })));
            expect(boundary.requests).toEqual([]);
        } finally { reply.resolve(null); await settled; }
    });

    it('cancels a queued preparation promptly without opening its predecessor dispatch fence', async () => {
        const routeReady = createDeferred<void>();
        prepareGrant = async () => { await routeReady.promise; };
        directReply = async (request) => (request.params as { seq: number }).seq;
        const call = createOrderedMachineRpcCaller();
        const params = { machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS };
        const first = call({ ...params, payload: { seq: 0 } });
        const abort = new AbortController();
        const cancelled = call({ ...params, payload: { seq: 1 }, signal: abort.signal });
        const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        const third = call({ ...params, payload: { seq: 2 } });
        const settled = Promise.allSettled([first, cancelled, third]);
        try {
            await vi.waitFor(() => expect(grantRequests).toHaveLength(1));
            abort.abort();
            await rejected;
            expect(directRequests).toEqual([]);
            expect(grantRequests).toHaveLength(1);
            routeReady.resolve();
            await expect(first).resolves.toBe(0);
            await expect(third).resolves.toBe(2);
            expect(directRequests.map(request => request.params)).toEqual([{ seq: 0 }, { seq: 2 }]);
            expect(boundary.requests).toEqual([]);
        } finally {
            routeReady.resolve();
            await settled;
        }
    });

    it('rejects promptly during peer-route discovery and does not dispatch after it later resolves', async () => {
        const routeReady = createDeferred<void>();
        prepareGrant = async () => { await routeReady.promise; };
        const controller = new AbortController();
        const pending = machineRpcWithServerScope({
            machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true }, signal: controller.signal,
        });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        try {
            await vi.waitFor(() => expect(grantRequests).toHaveLength(1));
            controller.abort();
            await rejected;
            routeReady.resolve();
            // Observe the real route consumer after the delayed HTTP grant.
            await vi.waitFor(() => expect(getMachineRpcPeerMediationReceiptsSnapshot()).toContainEqual(
                expect.objectContaining({ receipt: PEER_MEDIATION_RECEIPTS.routeSelected }),
            ));
            expect(directRequests).toEqual([]);
            expect(boundary.requests).toEqual([]);
        } finally {
            routeReady.resolve();
            await Promise.allSettled([pending]);
        }
    });

    it('rejects with an abort error when the signal fires during an in-flight direct call', async () => {
        const reply = createDeferred<unknown>();
        directReply = async () => await reply.promise;
        const controller = new AbortController();
        const pending = machineRpcWithServerScope({
            machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true }, signal: controller.signal,
        });
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        try {
            await vi.waitFor(() => expect(directRequests).toHaveLength(1));
            controller.abort();
            await rejected;
            expect(directSignals[0]?.aborted).toBe(true);
            expect(boundary.requests).toEqual([]);
        } finally {
            reply.resolve(null);
            await Promise.allSettled([pending, ...directResponses]);
        }
    });

    it('rejects immediately without dispatching the direct request when already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(machineRpcWithServerScope({
            machineId: 'machine_1', method: RPC_METHODS.DAEMON_MEMORY_STATUS,
            payload: { includeWorkers: true }, signal: controller.signal,
        })).rejects.toMatchObject({ name: 'AbortError', code: 'MACHINE_RPC_ABORTED' });
        expect(grantRequests).toEqual([]);
        expect(directRequests).toEqual([]);
        expect(boundary.requests).toEqual([]);
    });
});
