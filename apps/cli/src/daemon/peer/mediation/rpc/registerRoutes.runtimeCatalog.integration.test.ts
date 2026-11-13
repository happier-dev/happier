import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { join } from 'node:path';

import {
    PEER_MACHINE_RPC_DIRECT_PATH_V2,
    PeerMachineRpcDirectResponseV2Schema,
    createDirectRouteGrantSigningInputV2,
    createPeerRouteProofSigningInputV2,
    digestSignedDirectRouteGrantV2,
    type DirectRouteGrantPayloadV2,
    type PeerMachineRpcDirectRequestV2,
    type PeerRouteEphemeralProofV2,
    type SignedDirectRouteGrantV2,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { Machine } from '@/api/types';
import { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { registerPeerMediationMachineRpcDirectRoutes } from './registerRoutes';
import type { PeerMachineRpcDirectHandlerManager } from './registerRoutes';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerApprovalRpcHandlers } from '@/rpc/handlers/approvals';
import { registerDaemonLiveStreamRelayHandlers } from '@/rpc/handlers/daemonLiveStreamRelay';
import { registerDaemonBrowserControlHandler } from '@/rpc/handlers/daemonBrowserControl';
import { createSurfaceInputControl } from '../../../surfaces/inputControl';
import { createBrowserDaemonControlBroker } from '../../../browser/control/broker';
import { createBrowserDaemonControlRoutes } from '../../../browser/control/routes';
import { createBrowserAutomationOwnerRegistry } from '../../../browser/automation/owners';
import { createBrowserAutomationDaemonService } from '../../../browser/automation/service';
import { createBrowserAutomationCdpAdapter } from '../../../browser/automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../../../browser/automation/adapters/controlBridge';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '../../../browser/sidecar/controlAdapter';
import { createBrowserCdpScreencastProducer } from '../../../browser/capture/cdpScreencast';
import { registerBrowserLiveCapture } from '../../../browser/capture/registration';
import { createMachineLiveStreamCaptureRegistry } from '../stream/captureRegistry';
import { createMachineLiveStreamRelayTerminator } from '../stream/relay';
import { createDaemonMachineLiveStreamCaptureAdapter } from '../stream/captureAdapter';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { registerDaemonMachineVitalsRpcHandlers } from '@/rpc/handlers/daemonMachineVitals';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import { createLinuxMachineVitalsReader } from '@/daemon/vitals/readers/linux';
import { createLinuxVitalsFixture } from '@/daemon/vitals/readers/linux.testkit';
import { MachineVitalsSnapshotV1Schema } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createScmBackendRegistry } from '@/scm/registry';
import { withTempDir } from '@/testkit/fs/tempDir';
import { mintDirectRouteGrantV2 } from '../../../../../../server/sources/app/machines/peer/mediation/mintDirectRouteGrantV1';

const installationStore = vi.hoisted(() => ({ identity: null as import('@happier-dev/protocol').MachineInstallationIdentityV1 | null }));
// Installation key storage and Home HTTP are system boundaries; admission and dispatch remain real.
vi.mock('@/daemon/identity/store', async importOriginal => ({
    ...await importOriginal<typeof import('@/daemon/identity/store')>(),
    readInstallationIdentityIfExistsSync: () => installationStore.identity,
}));

function installPeerMachineBoundary() {
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
    installationStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
        publicKey: toBase64Url(key.publicKey), privateKey: toBase64Url(key.secretKey) };
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'account_1' } });
    let current = true;
    let replaceOnVerify = false;
    let retireAfterVerify = false;
    const verification = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        expect(String(url)).toMatch(/\/v1\/machines\/machine_1\/admission\/verify$/u);
        expect(body).toMatchObject({ context: { actorAccountId: 'account_1', custodianAccountId: 'account_1',
            machineId: 'machine_1', installationId: '11111111-1111-4111-8111-111111111111', role: 'manage', encryptionMode: 'plain' } });
        if (replaceOnVerify && installationStore.identity) {
            installationStore.identity = { ...installationStore.identity, installationId: '22222222-2222-4222-8222-222222222222' };
        }
        const admitted = current;
        if (retireAfterVerify) current = false;
        return { status: admitted ? 200 : 403, data: { v: 1, ok: admitted } };
    });
    return { retire: () => { current = false; }, retireAfterNextVerification: () => { retireAfterVerify = true; },
        verificationCount: () => verification.mock.calls.length,
        replaceDuringVerify: () => { current = true; replaceOnVerify = true; }, dispose: () => {
        profile.mockRestore(); verification.mockRestore(); installationStore.identity = null;
    } };
}

const serverKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));

function toBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

function createGrant(input: Readonly<{
    grantId?: string;
    iat?: number;
    exp?: number;
    ephemeralSeed?: number;
    method?: string;
    accountId?: string;
    callerAuthority?: 'present_user' | 'account_automation';
    singleUse?: boolean;
    methods?: readonly string[];
}> = {}): Readonly<{
    grant: SignedDirectRouteGrantV2;
    ephemeralSecretKey: Uint8Array;
}> {
    const method = input.method ?? RPC_METHODS.DAEMON_MEMORY_STATUS;
    const ephemeralKeyPair = tweetnacl.sign.keyPair.fromSeed(
        new Uint8Array(32).fill(input.ephemeralSeed ?? 8),
    );
    const payload: DirectRouteGrantPayloadV2 = {
        v: 2,
        grantId: input.grantId ?? 'grant_rpc_v2',
        grantFamilyId: 'family_rpc_v2',
        accountId: input.accountId ?? 'account_1',
        machineId: 'machine_1',
        ...(input.callerAuthority ? { callerAuthority: input.callerAuthority } : {}),
        flowKind: 'machine_rpc',
        routeKind: 'loopback_direct',
        scope: {
            kind: 'machine_rpc',
            rpcScopeId: `machine_1:${method}`,
            allowedMethods: [...input.methods ?? [method]],
            ...(input.singleUse ? { highRiskSingleUseMethods: [method] } : {}),
            maxIdleMs: 30_000,
        },
        iat: input.iat ?? 1_000,
        exp: input.exp ?? 3_000,
        aud: 'happier-daemon-route-grant',
        endpointFingerprint: 'endpoint_1',
        proofKind: 'ephemeral_ed25519',
        ephemeralPublicKeyBase64Url: toBase64Url(ephemeralKeyPair.publicKey),
    };
    return {
        grant: {
            payload,
            signature: {
                keyId: 'server_key_1',
                alg: 'Ed25519',
                valueBase64Url: toBase64Url(tweetnacl.sign.detached(
                    Buffer.from(createDirectRouteGrantSigningInputV2(payload), 'utf8'),
                    serverKeyPair.secretKey,
                )),
            },
        },
        ephemeralSecretKey: ephemeralKeyPair.secretKey,
    };
}

function createProof(input: Readonly<{
    grant: SignedDirectRouteGrantV2;
    ephemeralSecretKey: Uint8Array;
    nonceByte: number;
}>): PeerRouteEphemeralProofV2 {
    const digest = digestSignedDirectRouteGrantV2(input.grant);
    const nonce = new Uint8Array(16).fill(input.nonceByte);
    return {
        v: 2,
        kind: 'ephemeral_ed25519',
        signedGrantDigestBase64Url: toBase64Url(digest),
        nonceBase64Url: toBase64Url(nonce),
        signatureBase64Url: toBase64Url(tweetnacl.sign.detached(
            createPeerRouteProofSigningInputV2({ digest, nonce }),
            input.ephemeralSecretKey,
        )),
    };
}

function createRequest(input: Readonly<{
    requestId: string;
    grant: SignedDirectRouteGrantV2;
    proof: PeerRouteEphemeralProofV2;
    method?: string;
    params?: unknown;
}>): PeerMachineRpcDirectRequestV2 {
    const method = input.method ?? RPC_METHODS.DAEMON_MEMORY_STATUS;
    const params = input.params ?? {};
    return {
        v: 2,
        requestId: input.requestId,
        method,
        params,
        routeKind: 'loopback_direct',
        flowKind: 'machine_rpc',
        endpointFingerprint: 'endpoint_1',
        grant: input.grant,
        proof: input.proof,
    };
}

function createApp(input: Readonly<{
    nowMs: () => number;
    invokeLocal: PeerMachineRpcDirectHandlerManager['invokeLocal'];
}>) {
    const app = fastify({ logger: false });
    registerPeerMediationMachineRpcDirectRoutes(app, {
        nowMs: input.nowMs,
        expected: {
            accountId: 'account_1',
            machineId: 'machine_1',
            flowKind: 'machine_rpc',
            routeKind: 'loopback_direct',
            endpointFingerprint: 'endpoint_1',
        },
        trustRoots: [{ keyId: 'server_key_1', publicKey: toBase64Url(serverKeyPair.publicKey) }],
        rpcHandlerManager: { invokeLocal: input.invokeLocal },
    });
    return app;
}

function createMachine(encryptionMode: 'plain' | 'e2ee' = 'e2ee'): Machine {
    return {
        id: 'machine_1',
        ...(encryptionMode === 'plain' ? { encryptionMode } : {
            encryptionMode, encryptionKey: new Uint8Array(32).fill(7), encryptionVariant: 'legacy' as const,
        }),
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function createDeferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve: (value: T) => void;
}> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function listenOnLoopback(app: ReturnType<typeof createApp>): Promise<string> {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected direct peer RPC test server TCP address');
    }
    return `http://127.0.0.1:${address.port}`;
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
    return await new Promise<T | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), timeoutMs);
        void promise.then((value) => {
            clearTimeout(timeout);
            resolve(value);
        });
    });
}

describe('registerPeerMediationMachineRpcDirectRoutes V2 grant admission', () => {
    it.each([false, true])('admits signed direct own isolation status once and refuses the next withdrawn request (withdraw after admission=%s)', async withdrawAfterAdmission => {
        const boundary = installPeerMachineBoundary();
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'account_1' })).toString('base64url')}.signature`;
        const client = new ApiMachineClient(token, createMachine('plain'), undefined, {
            resolveCurrentServerIdentityId: () => 'home',
        });
        const method = RPC_METHODS.MACHINES_AGENT_ISOLATION_STATUS;
        const app = createApp({ nowMs: () => 2_000, invokeLocal: client.getPeerMediationMachineRpcHandlerManager().invokeLocal });
        const invoke = async (nonceByte: number, accountId = 'account_1') => {
            const signed = createGrant({ method, accountId, grantId: `own-isolation:${nonceByte}` });
            const response = await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({ requestId: `own-isolation:${nonceByte}`, method, grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte }), params: { machineId: 'machine_1' } }) });
            return PeerMachineRpcDirectResponseV2Schema.parse(response.json());
        };
        try {
            expect(await invoke(41, 'foreign-account')).toMatchObject({ ok: false });
            expect(boundary.verificationCount()).toBe(0);
            if (withdrawAfterAdmission) boundary.retireAfterNextVerification();
            // The real constructor-registered own-status owner must still classify
            // the requester; merely reaching a stub handler is not a positive.
            expect(await invoke(42)).toMatchObject({ ok: true, result: { protection: 'trusted_administrator' } });
            expect(boundary.verificationCount()).toBe(1);
            boundary.retire();
            expect(await invoke(43)).toMatchObject({ ok: true, result: { errorCode: RPC_ERROR_CODES.FORBIDDEN } });
            expect(boundary.verificationCount()).toBe(2);
        } finally { await app.close(); await client.shutdown(); boundary.dispose(); }
    });

    it('admits signed direct SCM describe once without re-admitting the unchanged local invocation', async () => {
        await withTempDir('direct-scm-admission-', async directory => {
            const boundary = installPeerMachineBoundary();
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account_1' })).toString('base64url')}.signature`;
            const client = new ApiMachineClient(token, createMachine('plain'), undefined, {
                resolveCurrentServerIdentityId: () => 'home',
            });
            const manager = (client as unknown as Readonly<{ rpcHandlerManager: RpcHandlerRegistrar }>).rpcHandlerManager;
            // A genuinely empty configured backend catalog still uses the real
            // SCM registration, selection and non-repository response owners.
            registerScmHandlers(manager, directory, { machineId: 'machine_1', registry: createScmBackendRegistry([]) });
            const app = createApp({ nowMs: () => 2_000, invokeLocal: client.getPeerMediationMachineRpcHandlerManager().invokeLocal });
            try {
                const method = RPC_METHODS.SCM_BACKEND_DESCRIBE;
                const signed = createGrant({ method, grantId: 'scm-describe' });
                const response = await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                    payload: createRequest({ requestId: 'scm-describe', method, grant: signed.grant,
                        proof: createProof({ ...signed, nonceByte: 44 }), params: { cwd: directory } }) });
                expect(PeerMachineRpcDirectResponseV2Schema.parse(response.json()))
                    .toMatchObject({ ok: true, result: { success: true, isRepo: false } });
                expect(boundary.verificationCount()).toBe(1);
            } finally { await app.close(); await client.shutdown(); boundary.dispose(); }
        });
    });

    it('composes signed direct vitals with installed Machine admission and refuses revoked access', async () => {
        const native = await createLinuxVitalsFixture();
        const boundary = installPeerMachineBoundary();
        const client = new ApiMachineClient('token', createMachine('plain'));
        const sampler = createMachineVitalsSampler({ readers: createLinuxMachineVitalsReader({ root: native.root }),
            historyStore: await createMinuteHistoryStore({ directory: join(native.root, 'history') }) });
        const manager = (client as unknown as Readonly<{ rpcHandlerManager: RpcHandlerRegistrar }>).rpcHandlerManager;
        registerDaemonMachineVitalsRpcHandlers(manager, { sampler, target: () => ({ serverId: 'daemon-home',
            machineId: 'machine_1', installationId: installationStore.identity!.installationId, custodianAccountId: 'account_1' }) });
        const app = createApp({ nowMs: () => 2_000, invokeLocal: client.getPeerMediationMachineRpcHandlerManager().invokeLocal });
        const invoke = async (nonceByte: number, machineId = 'machine_1') => {
            const signed = createGrant({ method: RPC_METHODS.MACHINES_VITALS_GET, grantId: `vitals:${nonceByte}` });
            const response = await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({ requestId: `vitals:${nonceByte}`, method: RPC_METHODS.MACHINES_VITALS_GET,
                    grant: signed.grant, proof: createProof({ ...signed, nonceByte }),
                    params: { machineId, serverId: 'caller-local-home', view: 'summary' } }) });
            return PeerMachineRpcDirectResponseV2Schema.parse(response.json());
        };
        try {
            await sampler.start();
            const response = await invoke(31);
            expect(response).toMatchObject({ ok: true, result: { state: 'reporting', sample: {
                memory: { totalBytes: 102_400_000, availableBytes: 40_960_000 } } } });
            if (!response.ok) throw new Error('Expected admitted direct vitals');
            expect(MachineVitalsSnapshotV1Schema.parse(response.result)).toEqual(response.result);
            expect(await invoke(33, 'caller-selected-machine')).toMatchObject({ ok: true, result: { errorCode: RPC_ERROR_CODES.FORBIDDEN } });
            boundary.retire();
            expect(await invoke(32)).toMatchObject({ ok: true, result: { errorCode: RPC_ERROR_CODES.FORBIDDEN } });
            boundary.replaceDuringVerify();
            expect(await invoke(35)).toMatchObject({ ok: true, result: { errorCode: RPC_ERROR_CODES.FORBIDDEN } });
        } finally { await app.close(); await sampler.stop(); boundary.dispose(); await native.cleanup(); }
    });

    it.each([RPC_ERROR_CODES.FORBIDDEN, RPC_ERROR_CODES.METHOD_NOT_FOUND])('preserves typed handler refusals %s without treating them as missing handlers', async errorCode => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
        rpc.registerHandler(RPC_METHODS.DAEMON_MEMORY_STATUS, async () => { throw new RpcError('Private refusal', errorCode); });
        const app = createApp({ nowMs: () => 2_000, invokeLocal: rpc.invokeLocal.bind(rpc) });
        const signed = createGrant();
        try {
            const response = PeerMachineRpcDirectResponseV2Schema.parse((await app.inject({ method: 'POST',
                url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: createRequest({ requestId: 'typed-refusal',
                    grant: signed.grant, proof: createProof({ ...signed, nonceByte: 34 }) }) })).json());
            expect(response).toMatchObject({ ok: true, result: { errorCode } });
            expect(JSON.stringify(response)).not.toContain('Private refusal');
        } finally { await app.close(); }
    });
    it.each(['present_user', 'account_automation', undefined] as const)('uses signed direct authority for held Browser list and control %s', async callerAuthority => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
        const owners = createBrowserAutomationOwnerRegistry();
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const control = owners.getInputControl(view);
        const commands: string[] = [];
        // Only CDP is substituted; signed admission, RPC, broker, routes and input control are real.
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar',
            resolveInputControl: candidate => owners.getInputControl(candidate), transport: {
                openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
                dispatchPageCommand: async () => ({}),
                dispatchBrowserCommand: async command => {
                    command.signal?.throwIfAborted();
                    commands.push(command.method);
                    return { success: true };
                },
            } });
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter(adapter);
        const automation = createBrowserAutomationDaemonService({ owners,
            adapter: createBrowserAutomationCdpAdapter({ transport: createControlAdapterAutomationTransport({ adapter }) }) });
        const browserControl = createBrowserDaemonControlRoutes({ broker, automation: () => automation });
        registerDaemonBrowserControlHandler(rpc, { browserControl });
        const app = createApp({ nowMs: () => 2_000, invokeLocal: rpc.invokeLocal.bind(rpc) });
        const invoke = async (method: string, params: unknown, nonceByte: number) => {
            const signed = createGrant({ method, callerAuthority, grantId: `browser:${method}` });
            return (await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({ requestId: `request:${method}`, method, params, grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte }) }),
            })).json();
        };
        try {
            await browserControl.dispatchCommand({ kind: 'openView', commandId: 'open', ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } }, { authority: 'present_user' });
            await control.beginConfidentialityHold();
            commands.length = 0;
            const listed = await invoke(RPC_METHODS.DAEMON_BROWSER_VIEW_LIST,
                { machineId: 'machine_1', browserSessionId: 'browser' }, 15);
            expect.soft(listed).toMatchObject({ ok: true, result: { protocolVersion: 1,
                views: [expect.objectContaining(view)] } });
            const dispatched = await invoke(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
                { machineId: 'machine_1', command: { kind: 'focusView', commandId: 'focus', ...view } }, 16);
            expect.soft(dispatched).toMatchObject({ ok: true, result: { protocolVersion: 1,
                result: callerAuthority === 'present_user' ? { status: 'dispatched' }
                    : { status: 'failed', error: { code: 'permission_denied' } } } });
            expect(commands).toEqual(callerAuthority === 'present_user' ? ['Target.activateTarget'] : []);
            control.clearConfidentialityHold();
            commands.length = 0;
            const controller = new AbortController();
            controller.abort();
            await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
                { machineId: 'machine_1', command: { kind: 'focusView', commandId: 'cancelled-focus', ...view } },
                { verifiedPeerAuthority: 'present_user', signal: controller.signal })).rejects.toBe(controller.signal.reason);
            expect(commands).toEqual([]);
            const beforeControl = control.getStatus();
            await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
                { machineId: 'machine_1', command: { kind: 'takeControl', commandId: 'cancelled-control', ...view } },
                { verifiedPeerAuthority: 'present_user', signal: controller.signal })).rejects.toBe(controller.signal.reason);
            expect(control.getStatus()).toEqual(beforeControl);
        } finally { await app.close(); automation.dispose(); adapter.dispose(); }
    });
    it.each(['present_user', 'account_automation', undefined] as const)('admits a held browser viewer only from signed direct authority %s', async callerAuthority => {
        const method = RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START;
        const signed = createGrant({ method, callerAuthority });
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
        const control = createSurfaceInputControl();
        // CDP is the physical boundary; the signed direct route and all browser owners are real.
        const transport = {
            openPage: async () => ({ targetId: 'page', sessionId: 'cdp-page' }),
            dispatchPageCommand: async () => ({}),
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: (_listener: BrowserSidecarCdpEventSubscriber) => () => {},
        };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport });
        const contextCapture = { transport, resolvePageHandle: adapter.resolvePageHandle,
            subscribeCdpEvents: transport.subscribeCdpEvents, subscribeViewLifecycle: adapter.subscribeViewLifecycle };
        const producer = createBrowserCdpScreencastProducer({ contextCapture, resolveInputControl: () => control });
        const registry = createMachineLiveStreamCaptureRegistry();
        const registration = registerBrowserLiveCapture({ registry, contextCapture, producer, automation: () => null,
            resolveInputControl: () => control });
        const relay = createMachineLiveStreamRelayTerminator({ captureAdapter: createDaemonMachineLiveStreamCaptureAdapter(registry), machineId: 'machine_1', nowMs: () => 2_000, emitEnvelope: () => {} });
        registerDaemonLiveStreamRelayHandlers(rpc, { relay });
        const app = createApp({ nowMs: () => 2_000, invokeLocal: rpc.invokeLocal.bind(rpc) });
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const sourceId = browserViewKey(view);
        try {
            await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, ...view, platform: 'web',
                target: { kind: 'externalUrl', targetId: 'external', url: 'https://example.test/' } });
            await control.beginConfidentialityHold();
            const streamId = 'direct-browser-stream';
            const response = (await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({ requestId: 'viewer-request', method, grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte: 14 }), params: { protocolVersion: 1, machineId: 'machine_1',
                        startRequest: { v: 1, streamId, streamFamily: 'browser.streamed', sourceId,
                            sourceMachineId: 'machine_1', targetMachineId: 'viewer', routeKind: 'server_relay',
                            callerAuthority: 'present_user',
                            authorization: { payload: { v: 1, grantId: 'relay-grant', accountId: 'account', flowKind: 'live_stream',
                                routeKind: 'server_relay', sourceMachineId: 'machine_1', targetMachineId: 'viewer', streamId,
                                streamFamily: 'browser.streamed', sourceId, iat: 1_000, exp: 61_000,
                                aud: 'happier-live-stream-relay-authorization' },
                                signature: { keyId: 'key', alg: 'Ed25519', valueBase64Url: 'AQID' } } } } }),
            })).json();
            expect(response).toMatchObject({ ok: true, result: { protocolVersion: 1,
                result: callerAuthority === 'present_user' ? { ok: true, streamId } : { ok: false } } });
        } finally {
            await app.close(); await relay.dispose(); registration.dispose(); await producer.dispose(); adapter.dispose();
        }
    });
    it.each(['present_user', 'account_automation', undefined] as const)('uses only signed private continuation authority %s', async callerAuthority => {
        const method = RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE;
        const signed = createGrant({ method, callerAuthority });
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
        registerApprovalRpcHandlers({ rpcHandlerManager: rpc });
        const app = createApp({ nowMs: () => 2_000, invokeLocal: rpc.invokeLocal.bind(rpc) });
        try {
            const response = (await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({ requestId: 'private-request', method, grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte: 12 }),
                    params: { authority: 'present_user', choice: { kind: 'once', value: 'private-test-value' } } }),
            })).json();
            expect(response).toMatchObject({ ok: true, result: { status: 'refused',
                code: callerAuthority === 'present_user' ? 'approval_changed' : 'approval_required' } });
            expect(response).not.toHaveProperty('commandReceipt');
            expect(JSON.stringify(response)).not.toContain('private-test-value');
        } finally { await app.close(); }
    });
    // Approved B5: ordinary commands share their signed admission lifetime.
    it('reuses ordinary command grants without a single-use reservation', async () => {
        const method = RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR;
        let invoked = 0;
        const rpc = new RpcHandlerManager({ scopePrefix: 'machine_1', encryptionMode: 'plain', logger: () => {} });
        rpc.registerHandler(method, async () => ({ effect: ++invoked }));
        const app = createApp({ nowMs: () => 2_000, invokeLocal: rpc.invokeLocal.bind(rpc) });
        const signed = createGrant({ method });
        const fresh = createGrant({ method, grantId: 'independent_grant', ephemeralSeed: 9 });
        const post = async (grant: typeof signed, nonceByte: number) => {
            const request = createRequest({
                method, requestId: `command_${grant.grant.payload.grantId}_${nonceByte}`,
                grant: grant.grant, proof: createProof({ ...grant, nonceByte }),
            });
            return (await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: request })).json();
        };
        try {
            const responses = await Promise.all([post(signed, 1), post(signed, 2), post(fresh, 3)]);
            expect(responses.filter(response => response.ok)).toHaveLength(3);
            expect(responses.filter(response => response.reasonCode === 'direct_call_limit_exceeded')).toHaveLength(0);
            expect(invoked).toBe(3);
            for (const response of responses) expect(response).not.toHaveProperty('commandReceipt');
        } finally { await app.close(); }
    });

    it('reuses a signed grant for two listed methods and refuses unlisted methods and expiry', async () => {
        const methods = [RPC_METHODS.DAEMON_MEMORY_STATUS, RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET];
        const fixture = createGrant({ methods, callerAuthority: 'account_automation' });
        const mint = (binding: Readonly<{ accountId?: string; machineId?: string; endpointFingerprint?: string }> = {}) => {
            const minted = mintDirectRouteGrantV2({
                accountId: 'account_1', machineId: 'machine_1', callerAuthority: 'account_automation',
                flowKind: 'machine_rpc', routeKind: 'loopback_direct', scope: fixture.grant.payload.scope,
                endpointFingerprint: 'endpoint_1', ephemeralPublicKeyBase64Url: fixture.grant.payload.ephemeralPublicKeyBase64Url,
                nowMs: 1_000, ttlMs: 2_000, serverGateEnabled: true,
                signingKey: { keyId: 'server_key_1', secretKey: serverKeyPair.secretKey }, ...binding,
            });
            expect(minted.ok).toBe(true);
            if (!minted.ok) throw new Error('Expected real issuer admission');
            return { grant: minted.grant, ephemeralSecretKey: fixture.ephemeralSecretKey };
        };
        const signed = mint();
        let nowMs = 2_000;
        const invoked: string[] = [];
        const app = createApp({ nowMs: () => nowMs, invokeLocal: async (method, _params, options) => {
            invoked.push(method);
            return { authority: options?.verifiedPeerAuthority };
        } });
        const post = async (method: string, nonceByte: number, admission = signed) => (await app.inject({ method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: createRequest({ requestId: `reuse-${nonceByte}`,
                method, grant: admission.grant, proof: createProof({ ...admission, nonceByte }),
                params: { callerAuthority: 'present_user' } }) })).json();
        try {
            for (const [index, method] of [...methods, ...methods].entries()) {
                expect(await post(method, index)).toMatchObject({ ok: true, result: { authority: 'account_automation' } });
            }
            expect(await post(RPC_METHODS.DAEMON_BROWSER_VIEW_LIST, 5)).toMatchObject({ ok: false, reasonCode: 'method_not_allowed_by_grant' });
            for (const binding of [{ accountId: 'foreign-account' }, { machineId: 'foreign-machine' }]) {
                expect(await post(methods[0]!, 7, mint(binding))).toMatchObject({ ok: false, reasonCode: 'grant_scope_mismatch' });
            }
            expect(await post(methods[0]!, 8, mint({ endpointFingerprint: 'other-endpoint' })))
                .toMatchObject({ ok: false, reasonCode: 'endpoint_mismatch' });
            const forgedAuthority = { ...signed, grant: { ...signed.grant, payload: {
                ...signed.grant.payload, callerAuthority: 'present_user' as const,
            } } };
            expect(await post(methods[0]!, 9, forgedAuthority)).toMatchObject({ ok: false, reasonCode: 'grant_bad_signature' });
            nowMs = 3_000;
            expect(await post(methods[0]!, 6)).toMatchObject({ ok: false, reasonCode: 'grant_expired' });
            expect(invoked).toEqual([...methods, ...methods]);
        } finally { await app.close(); }
    });

    it('admits a valid signed request after a burst of invalid signatures on the same endpoint', async () => {
        const signed = createGrant();
        let invoked = 0;
        const app = createApp({ nowMs: () => 2_000, invokeLocal: async () => ({ effect: ++invoked }) });
        const request = createRequest({ requestId: 'valid_after_burst', grant: signed.grant,
            proof: createProof({ ...signed, nonceByte: 1 }) });
        try {
            const invalid = { ...request, grant: { ...signed.grant, signature: { ...signed.grant.signature,
                valueBase64Url: Buffer.alloc(64).toString('base64url') } } };
            for (let index = 0; index < 6; index++) {
                expect((await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: invalid })).json())
                    .toMatchObject({ ok: false, reasonCode: 'grant_bad_signature' });
            }
            expect((await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: request })).json())
                .toMatchObject({ ok: true, result: { effect: 1 } });
            expect(invoked).toBe(1);
        } finally { await app.close(); }
    });

    it('consumes one signed grant even when a replay uses an independently valid nonce and signature', async () => {
        const signed = createGrant({ singleUse: true });
        const app = createApp({ nowMs: () => 2_000, invokeLocal: async () => ({ ok: true }) });
        const first = createRequest({
            requestId: 'request_1',
            grant: signed.grant,
            proof: createProof({ ...signed, nonceByte: 1 }),
        });
        const second = createRequest({
            requestId: 'request_2',
            grant: signed.grant,
            proof: createProof({ ...signed, nonceByte: 2 }),
        });

        expect((await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: first })).json())
            .toMatchObject({ v: 2, ok: true });
        expect((await app.inject({ method: 'POST', url: PEER_MACHINE_RPC_DIRECT_PATH_V2, payload: second })).json())
            .toMatchObject({ v: 2, ok: false, reasonCode: 'direct_call_limit_exceeded' });
        await app.close();
    });

    it('admits exactly one concurrent winner for a signed grant', async () => {
        const signed = createGrant({ singleUse: true });
        let invoked = 0;
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async () => {
                invoked += 1;
                await Promise.resolve();
                return { ok: true };
            },
        });
        const responses = await Promise.all([1, 2].map(async (nonceByte) => (
            await app.inject({
                method: 'POST',
                url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({
                    requestId: `request_${nonceByte}`,
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte }),
                }),
            })
        ).json()));

        expect(responses.filter((response) => response.ok === true)).toHaveLength(1);
        expect(responses.filter((response) => response.reasonCode === 'direct_call_limit_exceeded')).toHaveLength(1);
        expect(invoked).toBe(1);
        await app.close();
    });

    it('returns a typed terminal response for a throwing handler and retains consumption', async () => {
        const signed = createGrant({ singleUse: true });
        let invoked = 0;
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async () => {
                invoked += 1;
                throw new Error('local handler failed');
            },
        });
        const post = async (nonceByte: number) => (
            await app.inject({
                method: 'POST',
                url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({
                    requestId: `request_${nonceByte}`,
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte }),
                }),
            })
        ).json();

        expect(PeerMachineRpcDirectResponseV2Schema.parse(await post(1)))
            .toMatchObject({ v: 2, ok: true, result: { errorCode: 'handler_failed' } });
        expect(await post(2)).toMatchObject({ v: 2, ok: false, reasonCode: 'direct_call_limit_exceeded' });
        expect(await post(3)).toMatchObject({ v: 2, ok: false, reasonCode: 'direct_call_limit_exceeded' });
        const fresh = createGrant({ grantId: 'grant_after_handler_throw', ephemeralSeed: 9 });
        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: createRequest({
                requestId: 'request_fresh',
                grant: fresh.grant,
                proof: createProof({ ...fresh, nonceByte: 4 }),
            }),
        })).json()).toMatchObject({ v: 2, ok: true, result: { errorCode: 'handler_failed' } });
        expect(invoked).toBe(2);
        await app.close();
    });

    it('retains consumption when the activated handler returns unavailable', async () => {
        const signed = createGrant({ singleUse: true });
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async () => ({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        });
        const post = async (nonceByte: number) => (
            await app.inject({
                method: 'POST',
                url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
                payload: createRequest({
                    requestId: `request_${nonceByte}`,
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte }),
                }),
            })
        ).json();

        expect(await post(1)).toMatchObject({ v: 2, ok: false, reasonCode: 'handler_unavailable' });
        expect(await post(2)).toMatchObject({ v: 2, ok: false, reasonCode: 'direct_call_limit_exceeded' });
        await app.close();
    });

    it('does not reserve on invalid proof or scope and prunes consumption at expiry for a fresh grant', async () => {
        let nowMs = 2_000;
        let invoked = 0;
        const app = createApp({ nowMs: () => nowMs, invokeLocal: async () => ({ invocation: ++invoked }) });
        const signed = createGrant({ singleUse: true });
        const validProof = createProof({ ...signed, nonceByte: 1 });
        const invalidProof: PeerRouteEphemeralProofV2 = {
            ...validProof,
            signatureBase64Url: toBase64Url(new Uint8Array(64).fill(99)),
        };

        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: {
                ...createRequest({
                    requestId: 'outside_scope',
                    grant: signed.grant,
                    proof: createProof({ ...signed, nonceByte: 0 }),
                }),
                method: RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET,
            },
        })).json()).toMatchObject({ v: 2, ok: false, reasonCode: 'method_not_allowed_by_grant' });

        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: createRequest({ requestId: 'invalid', grant: signed.grant, proof: invalidProof }),
        })).json()).toMatchObject({ v: 2, ok: false, reasonCode: 'nonce_bad_signature' });
        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: createRequest({ requestId: 'valid', grant: signed.grant, proof: validProof }),
        })).json()).toMatchObject({ v: 2, ok: true });

        nowMs = 3_000;
        const fresh = createGrant({ grantId: signed.grant.payload.grantId, iat: 3_000, exp: 4_000, ephemeralSeed: 9 });
        expect((await app.inject({
            method: 'POST',
            url: PEER_MACHINE_RPC_DIRECT_PATH_V2,
            payload: createRequest({
                requestId: 'fresh',
                grant: fresh.grant,
                proof: createProof({ ...fresh, nonceByte: 2 }),
            }),
        })).json()).toMatchObject({ v: 2, ok: true });
        expect(invoked).toBe(2);
        await app.close();
    });

    it('propagates a cancelled direct peer request to the canonical contributed Action handler', async () => {
        const actionId = 'acme.direct/run';
        const occurrenceId = createPluginRuntimeOccurrenceId('acme.direct');
        const boundary = installPeerMachineBoundary();
        const client = new ApiMachineClient('token', createMachine('plain'));
        const actionStarted = createDeferred<void>();
        const actionAborted = createDeferred<boolean>();
        let releaseAction = () => {};

        const targetActionInvocations = createTargetActionInvocationRegistry({
            readCurrentPluginOccurrenceId: pluginId => pluginId === 'acme.direct' ? occurrenceId : null,
            actions: [{
                pluginId: 'acme.direct',
                pluginVersion: '1.0.0',
                occurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'direct-action-fixture' },
                localId: 'run',
                definition: {
                    id: 'run',
                    dangerLevel: 'safe',
                    scopes: ['global'],
                    surfaces: ['ui'],
                },
                handler: async (_input, context) => {
                    const signal = context.signal;
                    actionStarted.resolve(undefined);
                    await new Promise<void>((resolve) => {
                        let settled = false;
                        const finish = () => {
                            if (settled) return;
                            settled = true;
                            signal.removeEventListener('abort', onAbort);
                            resolve();
                        };
                        const onAbort = () => {
                            actionAborted.resolve(signal.aborted);
                            finish();
                        };
                        releaseAction = finish;
                        if (signal.aborted) {
                            onAbort();
                        } else {
                            signal.addEventListener('abort', onAbort, { once: true });
                        }
                    });
                    return { cancelled: signal.aborted };
                },
            }],
            resolveAuthorizationFacts: (action) => ({
                generation: {
                    targetGeneration: action.occurrenceId,
                    desiredGeneration: action.occurrenceId,
                    appliedGeneration: action.occurrenceId,
                },
                resourceSelections: [],
                scopedGrants: [],
                operatingSystemAuthorization: [],
            }),
            createServices: createUnavailablePluginServicesFactory(),
            resolveHostBinding: createTargetActionHostBindingResolver(),
        });
        // Fixture boundary: this production adapter reads only the canonical
        // contribution lookup and target Action registry below.
        const runtimeRegistry = {
            readPluginOccurrenceId: (pluginId: string) => pluginId === 'acme.direct' ? occurrenceId : null,
            contributes: {
                occurrenceIdsByPluginId: { 'acme.direct': occurrenceId },
                actionsById: new Map([[
                    actionId,
                    {
                        pluginId: 'acme.direct',
                        definition: {
                            id: 'run',
                            surfaces: { ui: true },
                            placementBindings: ['composer.primary'],
                        },
                    },
                ]]),
            },
            targetActionInvocations,
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        const handlerManager = (client as unknown as Readonly<{
            rpcHandlerManager: RpcHandlerRegistrar;
        }>).rpcHandlerManager;
        registerDaemonContributionRegistryProjectionHandler(handlerManager, {
            resolveRuntimeRegistry: async () => runtimeRegistry,
            resolveGeneration: async () => 7,
        });
        const peerHandlerManager = client.getPeerMediationMachineRpcHandlerManager();
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async (method, params, options) => await peerHandlerManager.invokeLocal(
                method,
                params,
                options,
            ),
        });

        try {
            const baseUrl = await listenOnLoopback(app);
            const signed = createGrant({
                grantId: 'grant_direct_action_cancel',
                method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            });
            const params = {
                machineId: 'machine_1',
                expectedContributorOccurrenceId: occurrenceId,
                qualifiedActionId: actionId,
                input: { title: 'Cancel me' },
                executionSurface: 'ui',
                invocation: {
                    kind: 'hostPresentedComposer',
                    currentComposerIntent: {
                        composer: { kind: 'newSession', instanceId: 'direct-action-composer' },
                        revision: 1,
                    },
                },
            };
            const request = createRequest({
                requestId: 'request_direct_action_cancel', grant: signed.grant,
                proof: createProof({ ...signed, nonceByte: 1 }),
                method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, params,
            });
            const controller = new AbortController();
            const requestPromise = fetch(`${baseUrl}${PEER_MACHINE_RPC_DIRECT_PATH_V2}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(request),
                signal: controller.signal,
            });

            const started = await settleWithin(actionStarted.promise, 1_000);
            if (started === null) {
                const response = await settleWithin(requestPromise, 100);
                const responseBody = response ? await response.text() : null;
                controller.abort();
                throw new Error(
                    responseBody !== null
                        ? `Canonical contributed Action did not start: ${responseBody}`
                        : 'Canonical contributed Action did not start or settle',
                );
            }
            controller.abort();

            await expect(requestPromise).rejects.toMatchObject({ name: 'AbortError' });
            expect(await settleWithin(actionAborted.promise, 500)).toBe(true);
            await expect(settleWithin(client.awaitPendingRpcRequests(), 500)).resolves.toBeUndefined();
        } finally {
            releaseAction();
            await settleWithin(client.awaitPendingRpcRequests(), 500);
            await app.close().catch(() => undefined);
            await client.shutdown().catch(() => undefined);
            boundary.dispose();
        }
    });

    it('isolates concurrent direct request lifetimes so a cancelled peer does not abort a normal peer', async () => {
        const firstStarted = createDeferred<void>();
        const secondStarted = createDeferred<void>();
        const firstAborted = createDeferred<boolean>();
        const releaseFirst = createDeferred<void>();
        const releaseSecond = createDeferred<void>();
        let firstSignal: AbortSignal | undefined;
        let secondSignal: AbortSignal | undefined;
        const app = createApp({
            nowMs: () => 2_000,
            invokeLocal: async (_method, params, options) => {
                const invocation = (params as Readonly<{ invocation: string }>).invocation;
                if (invocation === 'cancelled') {
                    firstSignal = options?.signal;
                    firstStarted.resolve(undefined);
                    await new Promise<void>((resolve) => {
                        const finish = () => {
                            firstSignal?.removeEventListener('abort', onAbort);
                            resolve();
                        };
                        const onAbort = () => {
                            firstAborted.resolve(firstSignal?.aborted === true);
                            finish();
                        };
                        void releaseFirst.promise.then(finish);
                        if (firstSignal?.aborted) {
                            onAbort();
                        } else {
                            firstSignal?.addEventListener('abort', onAbort, { once: true });
                        }
                    });
                    return { invocation };
                }

                secondSignal = options?.signal;
                secondStarted.resolve(undefined);
                await releaseSecond.promise;
                return { invocation };
            },
        });

        try {
            const baseUrl = await listenOnLoopback(app);
            const firstSigned = createGrant({
                grantId: 'grant_direct_cancelled_peer',
                ephemeralSeed: 9,
            });
            const secondSigned = createGrant({
                grantId: 'grant_direct_normal_peer',
                ephemeralSeed: 10,
            });
            const firstRequest = createRequest({
                requestId: 'request_direct_cancelled_peer',
                grant: firstSigned.grant,
                proof: createProof({ ...firstSigned, nonceByte: 1 }),
                params: { invocation: 'cancelled' },
            });
            const secondRequest = createRequest({
                requestId: 'request_direct_normal_peer',
                grant: secondSigned.grant,
                proof: createProof({ ...secondSigned, nonceByte: 2 }),
                params: { invocation: 'normal' },
            });
            const controller = new AbortController();
            const firstResponse = fetch(`${baseUrl}${PEER_MACHINE_RPC_DIRECT_PATH_V2}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(firstRequest),
                signal: controller.signal,
            });
            const secondResponse = fetch(`${baseUrl}${PEER_MACHINE_RPC_DIRECT_PATH_V2}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(secondRequest),
            });

            expect(await Promise.all([
                settleWithin(firstStarted.promise, 1_000),
                settleWithin(secondStarted.promise, 1_000),
            ])).toEqual([undefined, undefined]);
            controller.abort();

            await expect(firstResponse).rejects.toMatchObject({ name: 'AbortError' });
            expect(await settleWithin(firstAborted.promise, 500)).toBe(true);
            expect(secondSignal?.aborted).toBe(false);

            releaseSecond.resolve(undefined);
            expect((await secondResponse).status).toBe(200);
            expect(secondSignal?.aborted).toBe(false);
        } finally {
            releaseFirst.resolve(undefined);
            releaseSecond.resolve(undefined);
            await app.close().catch(() => undefined);
        }
    });
});
