import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    bindApiSessionSocketSequenceMock,
    createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { activateSessionsRoleForMachineClient } from '@/daemon/testkit/sessionsRole.testkit';
import type { DaemonState, Machine, MachineMetadata } from './types';

import { ApiMachineClient } from './apiMachine';
import { encodeBase64, encrypt } from './encryption';
import { AccountProfileResponseSchema, decodePlainMachineStoredContent, FeaturesResponseSchema, MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, RPC_METHODS } from '@happier-dev/protocol';
import { createClientActionMachineRpcExecutor } from '@/plugins/runtime/invocation/actions/clientActionMachineRpc';
import { createBrowserAutomationReverseDispatcher } from '@/daemon/browser/automation/reverseDispatch';
import { createClientActionReverseDispatcher } from '@/session/actions/clientActionReverseDispatch';
import { createBrowserRecordingNativeViewCaptureAdapter } from '@/daemon/browser/recording/adapters/nativeView';
import { createBrowserRecordingNativeViewCaptureCommand } from '@/daemon/browser/recording/adapters/nativeViewCommand';
import { createDesktopBrowserRecordingNativeViewCaptureTransport } from '@/daemon/browser/recording/adapters/nativeViewTransport';
import { createReverseDesktopBrowserRecordingNativeViewCaptureInvoke } from '@/daemon/browser/recording/adapters/reverseCaptureInvoke';
import { createDesktopReverseBrowserRecordingCaptureUiCall } from '@/daemon/browser/recording/reverseChannel/desktopReverseCaptureUiCall';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

const ioMock = vi.hoisted(() => vi.fn());
const axiosGetMock = vi.hoisted(() => vi.fn());
const probeReadinessMock = vi.hoisted(() => vi.fn(async () => ({ status: 'ready' as const })));
const backoffMock = vi.hoisted(() => vi.fn(async (fn: () => Promise<unknown>) => await fn()));

vi.mock('socket.io-client', () => ({
    io: ioMock,
}));

vi.mock('axios', async (importOriginal) => {
    const actual = await importOriginal<typeof import('axios')>();
    return { ...actual, default: { ...actual.default, get: axiosGetMock } };
});

vi.mock('@/configuration', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/configuration')>(),
    configuration: {
        ...(await importOriginal<typeof import('@/configuration')>()).configuration,
        serverUrl: 'https://example.test',
        apiServerUrl: 'https://example.test',
        activeServerDir: '/tmp/happier-api-machine-quiescence-test',
        happyHomeDir: '/tmp/happier-api-machine-quiescence-test',
        currentCliVersion: '0.0.0-test',
        socketForceWebsocketOnly: false,
        socketIoTransports: ['polling', 'websocket'],
    },
}));

vi.mock('@/utils/proxy/socketIoProxy', () => ({
    getSocketIoProxyOptions: () => ({}),
}));

vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
    createLoopbackReadinessProbe: () => probeReadinessMock,
}));

vi.mock('@/utils/time', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/time')>(),
    backoff: backoffMock,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        debugLargeJson: () => undefined,
    },
}));

function createMachine(): Machine {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function createPlainMachine(): Machine {
    return {
        id: 'machine-plain-1',
        encryptionMode: 'plain',
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

function createMachineMetadata(): MachineMetadata {
    return {
        host: 'test-host',
        platform: 'darwin',
        happyCliVersion: '0.0.0-test',
        homeDir: '/Users/test',
        happyHomeDir: '/Users/test/.happier',
        happyLibDir: '/Users/test/.happier/lib',
    };
}

function encryptForMachine(machine: Machine, value: unknown): string {
    if (machine.encryptionMode === 'plain') {
        throw new Error('Expected encrypted machine fixture');
    }
    return encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, value));
}

const ownerToken = `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`;

describe('ApiMachineClient daemon quiescence admission', () => {
    it('sends no reverse client RPC for another Account through any daemon route into its own Apps', async () => {
        // MACH-PRINCIPAL-AUDIT-1116 A-R4 / SEC 1116C: the Machine socket reaches the daemon
        // Account's Apps; a hosted member's client, plugin or App-view Action never uses them.
        const emitted: string[] = [];
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, payload) => {
            emitted.push(String((payload as { method?: unknown }).method));
            return { ok: true, result: { v: 1, execution: { ok: true, result: {} } } };
        } });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);
        const plugin = createClientActionMachineRpcExecutor(() => client);
        const browser = createBrowserAutomationReverseDispatcher({ getMachineClient: () => client });
        const presenter = createClientActionReverseDispatcher(() => client);
        const contributed = { v: 1 as const, action: { pluginId: 'example.plugin', localId: 'open' }, input: null, surface: 'agent' as const };
        const context = (accountId: string) => ({ surface: 'agent' as const, authority: 'account_automation' as const, runtimeAccountId: accountId,
            defaultSessionId: 'hosted-session' });
        const view = { browserSessionId: 'browser', viewId: 'app-view', actionKind: 'snapshot' };
        expect(await plugin(contributed, { principalAccountId: 'member' })).toMatchObject({ ok: false, actionHandlerInvocation: 'notStarted' });
        expect(await browser({ actionId: 'browser.automation.snapshot', input: view, context: context('member') } as never)).toMatchObject({ ok: false });
        // Typed client absence (inbox.get settles as status 'unavailable'), never a delivery.
    expect(await presenter({ actionId: 'inbox.get', input: {}, context: context('member') })).toEqual({ ok: true, result: { status: 'unavailable' } });
        expect(emitted).toEqual([]);
        await plugin(contributed, { principalAccountId: 'owner' });
        await browser({ actionId: 'browser.automation.snapshot', input: view, context: context('owner') } as never);
        await presenter({ actionId: 'inbox.get', input: {}, context: context('owner') });
        expect(emitted).toHaveLength(3);
    });

    it('keeps a received client receipt when the socket disconnects immediately afterwards', async () => {
        const receipt = { v: 1, execution: { ok: true, result: { status: 'opened' } } };
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async () => {
            socket.connected = false;
            return { ok: true, result: receipt };
        } });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);
        expect(await client.callConnectedClientRpc('ui.navigation', {}, { timeoutMs: null, principalAccountId: 'owner' }))
            .toEqual({ ok: true, result: receipt });
    });

    afterEach(() => {
        backoffMock.mockReset();
        backoffMock.mockImplementation(async (fn: () => Promise<unknown>) => await fn());
        probeReadinessMock.mockClear();
        ioMock.mockReset();
        axiosGetMock.mockReset();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('suppresses first metadata and daemon-state attempts while quiescing', async () => {
        const socket = createApiSessionSocketStub({ connected: true });
        const metadataHandler = vi.fn(() => createMachineMetadata());
        const daemonStateHandler = vi.fn(() => ({ status: 'running' as const }));
        const client = new ApiMachineClient(
            'token',
            createMachine(),
            undefined,
            { isDaemonQuiescing: () => true },
        );
        Reflect.set(client, 'socket', socket);

        const metadataOutcome = await client.updateMachineMetadata(metadataHandler);
        const daemonStateOutcome = await client.updateDaemonState(daemonStateHandler);

        expect(metadataOutcome).toBe('suppressed');
        expect(daemonStateOutcome).toBe('suppressed');
        expect(metadataHandler).not.toHaveBeenCalled();
        expect(daemonStateHandler).not.toHaveBeenCalled();
        expect(backoffMock).not.toHaveBeenCalled();
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('settles an issued UI Action as unknown when its last answering handler disappears', async () => {
        let markIssued!: () => void;
        const issued = new Promise<void>((resolve) => { markIssued = resolve; });
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: () => {
                markIssued();
                return new Promise<unknown>(() => {});
            },
        });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);
        const advertisedMethods: unknown = Reflect.get(client, 'connectedClientRpcMethods');
        if (!(advertisedMethods instanceof Set)) throw new Error('Missing machine RPC advertisement fixture');
        advertisedMethods.add(`machine-plain-1:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`);
        const execute = createClientActionMachineRpcExecutor(() => client);
        let outcome: Awaited<ReturnType<typeof execute>> | undefined;
        const pending = execute({
            v: 1, action: { pluginId: 'acme.client', localId: 'run' }, input: {},
            surface: 'agent', expectedContributorOccurrenceId: 'acme.client:1',
        }, { principalAccountId: 'owner' }).then((result) => { outcome = result; return result; });
        expect(await Promise.race([issued.then(() => 'issued'), pending])).toBe('issued');
        socket.trigger(SOCKET_RPC_EVENTS.UNREGISTERED, { method: `machine-plain-1:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}` });
        await vi.waitFor(() => expect(outcome).toMatchObject({ ok: false, errorCode: 'plugin_action_outcome_unknown' }));
        expect(await pending).not.toHaveProperty('actionHandlerInvocation');
        expect(socket.timeout).not.toHaveBeenCalledWith(expect.any(Number));
        expect(socket.emitWithAck).toHaveBeenCalledTimes(1);
        expect(socket.emitWithAck.mock.calls[0]?.[1]).toHaveProperty('timeoutMs', null);
        expect(socket.getHandlers(SOCKET_RPC_EVENTS.UNREGISTERED)).toHaveLength(0);
    });

    it('reports unchanged metadata without emitting an update', async () => {
        const metadata = createMachineMetadata();
        const machine = {
            ...createMachine(),
            metadata,
        };
        const socket = createApiSessionSocketStub({ connected: true });
        const client = new ApiMachineClient('token', machine);
        Reflect.set(client, 'socket', socket);

        const outcome = await client.updateMachineMetadata(() => ({ ...metadata }));

        expect(outcome).toBe('unchanged');
        expect(socket.emitWithAck).not.toHaveBeenCalled();
    });

    it('reports a successful metadata acknowledgement as published', async () => {
        const machine = createMachine();
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: (event, payload) => {
                if (event !== 'machine-update-metadata') {
                    throw new Error(`unexpected event: ${event}`);
                }
                return {
                    result: 'success',
                    version: 1,
                    metadata: (payload as { metadata: string }).metadata,
                };
            },
        });
        const client = new ApiMachineClient('token', machine);
        Reflect.set(client, 'socket', socket);

        const outcome = await client.updateMachineMetadata(() => createMachineMetadata());

        expect(outcome).toBe('published');
        expect(machine.metadata).toEqual(createMachineMetadata());
    });

    it('publishes plaintext machine metadata without encryption material', async () => {
        const machine = createPlainMachine();
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: (event, payload) => {
                if (event !== 'machine-update-metadata') {
                    throw new Error(`unexpected event: ${event}`);
                }
                const metadata = (payload as { metadata: string }).metadata;
                expect(decodePlainMachineStoredContent(metadata)).toEqual(createMachineMetadata());
                return {
                    result: 'success',
                    version: 1,
                    metadata,
                };
            },
        });
        const client = new ApiMachineClient('token', machine);
        Reflect.set(client, 'socket', socket);

        const outcome = await client.updateMachineMetadata(() => createMachineMetadata());

        expect(outcome).toBe('published');
        expect(machine.metadata).toEqual(createMachineMetadata());
    });

    it('round-trips connected-client RPC as plaintext without encryption material', async () => {
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: (event, payload) => {
                expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
                expect(payload).toMatchObject({
                    method: 'machine-plain-1:ui.demo',
                    params: { hello: 'ui' },
                });
                return { ok: true, result: { hello: 'daemon' } };
            },
        });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);

        await expect(client.callConnectedClientRpc(
            'ui.demo',
            { hello: 'ui' },
            { principalAccountId: 'owner' },
        )).resolves.toEqual({
            ok: true,
            result: { hello: 'daemon' },
        });
    });

    it.each([
        [RPC_ERROR_CODES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN],
        [RPC_ERROR_CODES.METHOD_NOT_FOUND, 'desktop_browser_recording_capture_ui_unavailable'],
        [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, 'desktop_browser_recording_capture_ui_unavailable'],
    ])('retains recording reverse RPC refusal %s at native capture admission', async (errorCode, expectedCode) => {
        // The socket ACK is the external boundary; the Machine RPC, reverse
        // transport, capture command and native adapter all run their real code.
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: () => ({
            ok: false, error: 'Reverse capture refused', errorCode,
        }) });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);
        const adapter = createBrowserRecordingNativeViewCaptureAdapter({
            captureCommand: createBrowserRecordingNativeViewCaptureCommand({
                transport: createDesktopBrowserRecordingNativeViewCaptureTransport({
                    invokeRecordingFrameCapture: createReverseDesktopBrowserRecordingNativeViewCaptureInvoke({
                        callUi: createDesktopReverseBrowserRecordingCaptureUiCall({ getMachineClient: () => client }),
                    }),
                }),
            }),
        });
        await expect(adapter.start({ principalAccountId: 'owner', recording: {
            v: 1, recordingId: 'recording_reverse_rpc', browserSessionId: 'browser_session_1', viewId: 'view_1',
            profileId: 'profile_1', targetKind: 'streamedBrowser', adapterKind: 'localPreview',
            renderEngineKind: 'desktopWebView', captureKind: 'nativeViewCapture', fidelity: 'nativeCallback',
            startedAtMs: 1000, status: 'starting', navigationGenerationStart: 1, durationMs: 0,
            byteSize: 0, frameCount: 0, fps: 1, mimeType: 'image/png', retentionClass: 'preSend',
            redactionLevel: 'metadataOnly', policyState: 'allowed', actionChapters: [], relatedReferences: [],
        } })).resolves.toMatchObject({ status: 'unavailable', reason: { code: expectedCode } });
    });

    it('carries exact answering-client routing and its answering address through the Machine socket', async () => {
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (_event, payload) => {
            expect(payload).toMatchObject({ method: `machine-plain-1:answering-client.v1/${RPC_METHODS.UI_ACTION_EXECUTE}`,
                answeringClient: { clientId: 'app-b', requireSingle: true }, params: { hello: 'ui' } });
            return { ok: true, result: { status: 'applied' }, answeringClientId: 'app-b' };
        } });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);
        expect(await client.callConnectedClientRpc(RPC_METHODS.UI_ACTION_EXECUTE, { hello: 'ui' },
            { answeringClient: { clientId: 'app-b', requireSingle: true }, principalAccountId: 'owner' }))
            .toEqual({ ok: true, result: { status: 'applied' }, answeringClientId: 'app-b' });
    });

    it('preserves strictly admitted candidate clients from an ambiguous relay ACK', async () => {
        const answeringClients = [{ id: 'app-a', deviceLabel: null,
            state: { computer: true, focused: false, lastFocusedAt: 10 } }, { id: 'app-b', deviceLabel: null }];
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: () => ({
            ok: false, error: 'Choose a client', errorCode: 'RPC_CLIENT_AMBIGUOUS', answeringClients,
        }) });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);
        expect(await client.callConnectedClientRpc(RPC_METHODS.UI_ACTION_EXECUTE, {},
            { answeringClient: { requireSingle: true }, principalAccountId: 'owner' })).toMatchObject({
            ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS', answeringClients,
        });
    });

    it('forwards invoking cancellation to the issued connected-client RPC', async () => {
        let issued!: () => void;
        const sent = new Promise<void>(resolve => { issued = resolve; });
        let settle!: () => void;
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: () => { issued(); return new Promise(resolve => { settle = () => resolve({ ok: true, result: {} }); }); },
        });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);
        const abort = new AbortController();
        const running = client.callConnectedClientRpc('ui.demo', {}, { signal: abort.signal, principalAccountId: 'owner' });
        await sent;
        abort.abort();
        try {
            expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CANCEL, expect.objectContaining({ requestId: expect.any(String) }));
        } finally { settle(); }
        await expect(running).resolves.toMatchObject({ ok: false });
    });

    it('fails a connected-client RPC closed when the machine socket disconnects before the acknowledgement settles', async () => {
        let markIssued!: () => void;
        const issued = new Promise<void>(resolve => { markIssued = resolve; });
        let rejectAcknowledgement!: (error: Error) => void;
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: () => {
                markIssued();
                return new Promise<unknown>((_resolve, reject) => { rejectAcknowledgement = reject; });
            },
        });
        const client = new ApiMachineClient(ownerToken, createPlainMachine());
        Reflect.set(client, 'socket', socket);

        const pending = client.callConnectedClientRpc(
            'ui.demo',
            { hello: 'ui' },
            { timeoutMs: null, principalAccountId: 'owner' },
        );
        await issued;
        socket.connected = false;
        socket.trigger('disconnect', 'transport close');
        // Socket.IO rejects its pending ACKs on disconnect; the boundary stub
        // only dispatches listeners, so deliver that native rejection here.
        rejectAcknowledgement(new Error('socket has been disconnected'));
        await expect(pending).resolves.toMatchObject({
            ok: false,
            errorCode: 'RPC_OUTCOME_UNKNOWN',
        });
    });

    it('allows an explicit shutdown-state publication while quiescing', async () => {
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: (event, payload) => {
                if (event !== 'machine-update-state') {
                    throw new Error(`unexpected event: ${event}`);
                }
                return {
                    result: 'success',
                    version: 1,
                    daemonState: (payload as { daemonState: string }).daemonState,
                };
            },
        });
        const daemonStateHandler = vi.fn(() => ({ status: 'shutting-down' as const }));
        const client = new ApiMachineClient(
            'token',
            createMachine(),
            undefined,
            { isDaemonQuiescing: () => true },
        );
        Reflect.set(client, 'socket', socket);

        const outcome = await client.updateDaemonState(
            daemonStateHandler,
            { allowWhileQuiescing: true },
        );

        expect(outcome).toBe('published');
        expect(daemonStateHandler).toHaveBeenCalledTimes(1);
        expect(socket.emitWithAck).toHaveBeenCalledWith(
            'machine-update-state',
            expect.any(Object),
        );
    });

    it('suppresses the next metadata and daemon-state retry when quiescence starts after an admitted mismatch', async () => {
        let quiescing = false;
        const eventAttempts = new Map<string, number>();
        const machine = createMachine();
        const desiredMetadata = createMachineMetadata();
        const serverCurrentMetadata: MachineMetadata = {
            ...desiredMetadata,
            host: 'server-current-host',
        };
        const serverCurrentDaemonState: DaemonState = {
            status: 'running',
            pid: 404,
            startedAt: 1,
        };
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event, payload) => {
                const attempt = (eventAttempts.get(event) ?? 0) + 1;
                eventAttempts.set(event, attempt);
                const encryptedPayload = payload as {
                    metadata?: string;
                    daemonState?: string;
                };
                if (event === 'machine-update-metadata') {
                    return {
                        result: attempt === 1 ? 'version-mismatch' : 'success',
                        version: attempt,
                        metadata: attempt === 1
                            ? encryptForMachine(machine, serverCurrentMetadata)
                            : encryptedPayload.metadata,
                    };
                }
                if (event === 'machine-update-state') {
                    if (attempt === 1) quiescing = true;
                    return {
                        result: attempt === 1 ? 'version-mismatch' : 'success',
                        version: attempt,
                        daemonState: attempt === 1
                            ? encryptForMachine(machine, serverCurrentDaemonState)
                            : encryptedPayload.daemonState,
                    };
                }
                throw new Error(`unexpected event: ${event}`);
            },
        });
        const client = new ApiMachineClient(
            'token',
            machine,
            undefined,
            { isDaemonQuiescing: () => quiescing },
        );
        Reflect.set(client, 'socket', socket);

        const runWithOneRetry = async (fn: () => Promise<unknown>): Promise<unknown> => {
            try {
                return await fn();
            } catch {
                quiescing = true;
                return await fn();
            }
        };

        const metadataHandler = vi.fn(() => desiredMetadata);
        backoffMock.mockImplementationOnce(runWithOneRetry);
        const metadataOutcome = await client.updateMachineMetadata(metadataHandler);
        expect(metadataOutcome).toBe('suppressed');
        expect(metadataHandler).toHaveBeenCalledTimes(1);
        expect(eventAttempts.get('machine-update-metadata')).toBe(1);
        expect(machine.metadata).toEqual(serverCurrentMetadata);
        expect(machine.metadataVersion).toBe(1);
        expect(machine.metadata).not.toEqual(desiredMetadata);

        quiescing = false;
        const daemonStateHandler = vi.fn(() => ({ status: 'running' as const, pid: 123 }));
        const daemonStateOutcome = await client.updateDaemonState(daemonStateHandler);
        expect(daemonStateOutcome).toBe('suppressed');
        expect(daemonStateHandler).toHaveBeenCalledTimes(1);
        expect(eventAttempts.get('machine-update-state')).toBe(1);
        expect(machine.daemonState).toEqual(serverCurrentDaemonState);
        expect(machine.daemonStateVersion).toBe(1);
    });

    it('rejects unknown metadata and daemon-state acknowledgement results', async () => {
        const socket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: () => ({ result: 'unexpected-result' }),
        });
        const client = new ApiMachineClient('token', createMachine());
        Reflect.set(client, 'socket', socket);

        await expect(
            client.updateMachineMetadata(() => createMachineMetadata()),
        ).rejects.toBeInstanceOf(Error);
        await expect(
            client.updateDaemonState(() => ({ status: 'running' })),
        ).rejects.toBeInstanceOf(Error);
    });

    it('does not publish running state on a reconnect that arrives while quiescing', async () => {
        vi.stubEnv('HAPPY_ENABLE_V2_CHANGES', 'false');
        // The HTTP and Socket.IO transports are the boundaries; capability selection stays real.
        const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { session: {
            runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 3 }, publisherAuthority: { protocolVersion: 1 },
        } } });
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
            const path = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname;
            if (path !== '/v1/features' && path !== '/v1/features/authenticated') throw new Error(`Unexpected HTTP boundary: ${path}`);
            return new Response(JSON.stringify(features), { headers: { 'content-type': 'application/json' } });
        }));
        axiosGetMock.mockImplementation(async (url: string) => {
            if (new URL(url).pathname !== '/v1/account/profile') throw new Error(`Unexpected HTTP boundary: ${url}`);
            return { status: 200, data: AccountProfileResponseSchema.parse({ id: 'account-1' }) };
        });
        let quiescing = false;
        const acknowledgeRegistration: NonNullable<Parameters<typeof createApiSessionSocketStub>[0]>['emit'] = (event, [registration], socket) => {
            if (event === SOCKET_RPC_EVENTS.REGISTER) {
                queueMicrotask(() => socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, registration));
            }
        };
        const firstSocket = createApiSessionSocketStub({
            id: 'machine-socket-1',
            emit: acknowledgeRegistration,
            disconnectReason: 'transport close',
            emitWithAck: (event, payload) => {
                if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return { v: 1, result: 'success', revision: 1 };
                if (event === 'machine-update-state') {
                    return {
                        result: 'success',
                        version: 1,
                        daemonState: (payload as { daemonState: string }).daemonState,
                    };
                }
                return { result: 'success', version: 1 };
            },
        });
        const secondSocket = createApiSessionSocketStub({
            id: 'machine-socket-2',
            emit: acknowledgeRegistration,
            disconnectReason: 'transport close',
            emitWithAck: (event, payload) => {
                if (event === MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1) return { v: 1, result: 'success', revision: 2 };
                if (event === 'machine-update-state') {
                    return {
                        result: 'success',
                        version: 2,
                        daemonState: (payload as { daemonState: string }).daemonState,
                    };
                }
                return { result: 'success', version: 2 };
            },
        });
        bindApiSessionSocketSequenceMock(ioMock, [firstSocket, secondSocket]);
        const onConnect = vi.fn();
        const client = new ApiMachineClient(
            'token',
            createMachine(),
            undefined,
            { isDaemonQuiescing: () => quiescing },
        );
        client.onConnectedServicesProjection(async () => {});
        const sessionsRole = await activateSessionsRoleForMachineClient(client, client.setRPCHandlers({
            spawnSession: async () => { throw new Error('This fixture does not spawn a Session'); },
            stopSession: async () => true,
            requestShutdown() {},
        }));

        try {
            client.connect({ onConnect });
            await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
            await vi.waitFor(() => expect(client.isMachineControlRegistrationReady()).toBe(true));
            expect(firstSocket.emitWithAck).toHaveBeenCalledWith(
                'machine-update-state',
                expect.any(Object),
            );

            quiescing = true;
            firstSocket.disconnect();
            await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(2));
            await vi.waitFor(() => expect(client.isMachineControlRegistrationReady()).toBe(true));

            expect(secondSocket.emitWithAck).not.toHaveBeenCalledWith(
                'machine-update-state',
                expect.any(Object),
            );
            const socketOptions = ioMock.mock.calls[1]?.[1] as {
                auth?: Record<string, unknown>;
            };
            expect(socketOptions.auth).not.toHaveProperty('isDaemonQuiescing');
        } finally {
            try { await sessionsRole.stop(); } finally { await client.shutdown(); }
        }
    }, 5_000);
});
