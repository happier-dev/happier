import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReadinessProbeResult } from '@happier-dev/connection-supervisor';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ApiSessionClient } from './session/sessionClient';
import type { RawJSONLines } from '@/backends/claude/types';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { __resetToolTraceForTests } from '@/agent/tools/trace/toolTrace';
import {
    bindApiSessionSocketPairMock,
    createApiSessionSocketStub,
    flushApiSessionClientMessageCommitQueue,
} from '@/testkit/backends/apiSessionSocketHarness';
import { createMockSession, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { HttpStatusError } from './client/httpStatusError';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo } = vi.hoisted(() => ({
    mockIo: vi.fn(),
}));

let mockSocket: any;
let mockUserSocket: any;

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('./session/connection/createSessionSocketTransport', () => ({
    createSessionSocketTransport: () => ({
        socket: mockSocket,
        transport: {
            connect: async () => {},
            disconnect: async () => {
                mockSocket.disconnect();
            },
            destroy: async () => {
                mockSocket.removeAllListeners();
            },
            isConnected: () => true,
            onConnected: () => () => {},
            onDisconnected: () => () => {},
            onError: () => () => {},
        },
    }),
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
    DEFAULT_MANAGED_CONNECTION_POLICY: {},
    createManagedConnectionSupervisor: (params: {
        createTransport: () => unknown;
        onStateChange?: (state: { phase: string }) => Promise<void> | void;
        onConnected?: () => Promise<void> | void;
        onDisconnected?: () => Promise<void> | void;
        onAuthFailed?: () => Promise<void> | void;
    }) => {
        let transport: {
            disconnect?: () => Promise<void> | void;
            destroy?: () => Promise<void> | void;
        } | null = null;

        return {
            getState: () => ({
                phase: 'online',
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: Date.now(),
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            }),
            reportProbeResult: vi.fn(),
            start: async () => {
                params.onStateChange?.({ phase: 'connecting' });
                transport = params.createTransport() as typeof transport;
                params.onStateChange?.({ phase: 'online' });
                await params.onConnected?.();
            },
            stop: async () => {
                await transport?.disconnect?.();
                await transport?.destroy?.();
                params.onStateChange?.({ phase: 'offline' });
            },
        };
    },
}));

function createMockSocket() {
    return createApiSessionSocketStub() as any;
}

function createConfiguredSocket(
    options: Parameters<typeof createApiSessionSocketStub>[0] = {},
): any {
    return createApiSessionSocketStub(options) as any;
}

function replaceSocketPair(params: {
    sessionSocket?: any;
    userSocket?: any;
    fallbackSocket?: any;
} = {}): void {
    mockSocket = params.sessionSocket ?? createMockSocket();
    mockUserSocket = params.userSocket ?? createMockSocket();

    bindApiSessionSocketPairMock(mockIo, {
        sessionSocket: mockSocket,
        userSocket: mockUserSocket,
        fallbackSocket: params.fallbackSocket ?? mockSocket,
    });
}

function configureCommittedMessageAck(socket: any, result: {
    ok: boolean;
    id: string;
    seq: number;
    localId?: string;
    didWrite?: boolean;
}) {
    socket.connected = true;
    socket.timeout = vi.fn().mockReturnThis();
    socket.emitWithAck = vi.fn().mockResolvedValue(result);
}

function connectSessionSocket(socket: any = mockSocket): any {
    socket.connected = true;
    return socket;
}

function expectSocketHandler(
    socket: any,
    event: string,
): (...args: unknown[]) => void {
    const handler =
        typeof socket.getHandler === 'function'
            ? socket.getHandler(event)
            : socket.on?.mock?.calls?.find((call: any[]) => call[0] === event)?.[1];
    expect(typeof handler).toBe('function');
    return handler;
}

function expectLastSocketHandler(
    socket: any,
    event: string,
): (...args: unknown[]) => void {
    const handlers =
        typeof socket.getHandlers === 'function'
            ? socket.getHandlers(event)
            : socket.on?.mock?.calls
                  ?.filter((call: any[]) => call[0] === event)
                  .map((call: any[]) => call[1]);
    const handler = handlers?.[handlers.length - 1];
    expect(typeof handler).toBe('function');
    return handler;
}

async function flushClientQueue(client: ApiSessionClient): Promise<void> {
    await flushApiSessionClientMessageCommitQueue(client as any);
}

function getSocketMessageEmitCalls(socket: any): any[][] {
    return socket.emit.mock.calls.filter((call: any[]) => call[0] === 'message');
}

function getSocketMessageAckCalls(socket: any): any[][] {
    return socket.emitWithAck.mock.calls.filter((call: any[]) => call[0] === 'message');
}

function getSocketEventCalls(socket: any, event: string): any[][] {
    return socket.emit.mock.calls.filter((call: any[]) => call[0] === event);
}

function getSocketVolatileEventCalls(socket: any, event: string): any[][] {
    return socket.volatile?.emit?.mock?.calls?.filter((call: any[]) => call[0] === event) ?? [];
}

function getCommittedMessagePayloads(socket: any): any[] {
    return [
        ...getSocketMessageAckCalls(socket).map(([, payload]) => payload),
        ...getSocketMessageEmitCalls(socket).map(([, payload]) => payload),
    ];
}

function getLastCommittedMessagePayload(socket: any = mockSocket): any {
    return getCommittedMessagePayloads(socket).at(-1);
}

function decryptOutboundMessagePayload(
    session: any,
    payload: { message: string | { c?: string; t?: string; v?: unknown } },
): any {
    if (
        payload.message
        && typeof payload.message === 'object'
        && payload.message.t === 'plain'
    ) {
        return payload.message.v;
    }

    const encryptedMessage =
        typeof payload.message === 'string' ? payload.message : payload.message?.c;
    expect(typeof encryptedMessage).toBe('string');
    return decrypt(
        session.encryptionKey,
        session.encryptionVariant,
        decodeBase64(encryptedMessage as string),
    ) as any;
}

function getDecryptedOutboundMessages(
    session: any,
    socket: any = mockSocket,
): any[] {
    return getCommittedMessagePayloads(socket).map((payload) =>
        decryptOutboundMessagePayload(session, payload),
    );
}

function getLastDecryptedOutboundMessage(
    session: any,
    socket: any = mockSocket,
): any {
    const messages = getDecryptedOutboundMessages(session, socket);
    return messages.at(-1);
}

function encryptSessionValue(session: any, value: unknown): string {
    return encodeBase64(
        encrypt(session.encryptionKey, session.encryptionVariant, value),
    );
}

function buildEncryptedSessionContent(session: any, value: unknown): {
    t: 'encrypted';
    c: string;
} {
    return {
        t: 'encrypted',
        c: encryptSessionValue(session, value),
    };
}

function buildEncryptedTranscriptMessage(params: {
    session: any;
    plaintext: unknown;
    createdAt: number;
    id?: string;
    seq?: number;
}): any {
    return {
        id: params.id,
        seq: params.seq,
        content: buildEncryptedSessionContent(params.session, params.plaintext),
        createdAt: params.createdAt,
    };
}

function buildMessagesListResponse(messages: any[], status = 200): {
    status: number;
    data: {
        messages: any[];
        nextAfterSeq: null;
    };
} {
    return {
        status,
        data: {
            messages,
            nextAfterSeq: null,
        },
    };
}

async function waitForNextTick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function getSessionMessagesGetCalls(getSpy: ReturnType<typeof vi.spyOn>, sessionId: string): any[][] {
    return getSpy.mock.calls.filter(([url]) =>
        typeof url === 'string' && url.includes(`/v1/sessions/${sessionId}/messages`),
    );
}

function removeStartedByArgvFlag(): void {
    process.argv = process.argv.filter((arg) => arg !== '--started-by');
}

function startMetadataWait(
    client: ApiSessionClient,
    signal?: AbortSignal,
): Promise<boolean> {
    return client.waitForMetadataUpdate(signal);
}

function emitMetadataWakeUpdate(params: {
    session: any;
    path: string;
    socket?: any;
    updateId?: string;
    seq?: number;
    version?: number;
    idField?: 'id' | 'sid';
}): void {
    emitEncryptedSessionMetadataUpdate(params.socket ?? mockSocket, {
        session: params.session,
        updateId: params.updateId ?? 'update-metadata',
        seq: params.seq ?? 1,
        metadata: { ...params.session.metadata, path: params.path },
        version: params.version ?? 1,
        idField: params.idField,
    });
}

function triggerLastUserSocketLifecycleEvent(
    event: 'connect' | 'disconnect',
): void {
    const handler = expectLastSocketHandler(mockUserSocket, event);
    handler();
}

function stubMetadataSnapshotWake(
    client: ApiSessionClient,
    params: {
        path?: string;
        metadataVersion?: number;
        agentStateVersion?: number;
        waitForTick?: boolean;
    } = {},
): ReturnType<typeof vi.fn> {
    const syncSpy = vi.fn(async () => {
        if (params.waitForTick) {
            await waitForNextTick();
        }
        if (params.path !== undefined) {
            (client as any).metadata = { ...(client as any).metadata, path: params.path };
        }
        (client as any).metadataVersion = params.metadataVersion ?? 1;
        (client as any).agentStateVersion = params.agentStateVersion ?? 1;
        client.emit('metadata-updated');
    });
    (client as any).syncSessionSnapshotFromServer = syncSpy;
    return syncSpy;
}

function buildServerSessionSnapshotResponse(params: {
    session: any;
    metadataVersion: number;
    metadata: string;
}): {
    status: number;
    data: {
        session: Record<string, unknown>;
    };
} {
    return {
        status: 200,
        data: {
            session: createSessionRecordFixture({
                ...params.session,
                id: params.session.id,
                active: true,
                metadataVersion: params.metadataVersion,
                metadata: params.metadata,
            }),
        },
    };
}

function buildEncryptedSessionMessageUpdate(params: {
    session: any;
    updateId: string;
    seq: number;
    messageId: string;
    plaintext: unknown;
    localId?: string;
    createdAt?: number;
    sid?: string;
}): any {
    const session = params.session;
    const encrypted = encryptSessionValue(session, params.plaintext);

    return {
        id: params.updateId,
        seq: params.seq,
        createdAt: params.createdAt ?? Date.now(),
        body: {
            t: 'new-message',
            sid: params.sid ?? session.id,
            message: {
                id: params.messageId,
                seq: params.seq,
                ...(params.localId ? { localId: params.localId } : {}),
                content: { t: 'encrypted', c: encrypted },
            },
        },
    };
}

function emitEncryptedSessionMessageUpdate(
    socket: any,
    params: Parameters<typeof buildEncryptedSessionMessageUpdate>[0],
): void {
    const updateHandler = expectSocketHandler(socket, 'update');
    updateHandler(buildEncryptedSessionMessageUpdate(params) as any);
}

function buildEncryptedSessionMetadataUpdate(params: {
    session: any;
    updateId: string;
    seq: number;
    metadata: unknown;
    version: number;
    createdAt?: number;
    idField?: 'id' | 'sid';
}): any {
    const session = params.session;
    const encrypted = encryptSessionValue(session, params.metadata);
    const sessionField = params.idField ?? 'sid';

    return {
        id: params.updateId,
        seq: params.seq,
        createdAt: params.createdAt ?? Date.now(),
        body: {
            t: 'update-session',
            [sessionField]: session.id,
            metadata: {
                version: params.version,
                value: encrypted,
            },
        },
    };
}

function emitEncryptedSessionMetadataUpdate(
    socket: any,
    params: Parameters<typeof buildEncryptedSessionMetadataUpdate>[0],
): void {
    const updateHandler = expectSocketHandler(socket, 'update');
    updateHandler(buildEncryptedSessionMetadataUpdate(params) as any);
}

describe('ApiSessionClient connection handling', () => {
    let mockSession: any;
    let envScope: ReturnType<typeof createEnvKeyScope>;
    let originalArgv: string[];
    const createdClients: ApiSessionClient[] = [];
    const createClient = (token: string, session: any): ApiSessionClient => {
        const client = new ApiSessionClient(token, session);
        createdClients.push(client);
        return client;
    };
    const overrideSessionSupervisor = (client: ApiSessionClient, reportProbeResult: ReturnType<typeof vi.fn>): void => {
        Object.defineProperty(client, 'sessionConnectionSupervisor', {
            configurable: true,
            value: {
                stop: vi.fn(async () => {}),
                getState: () => ({
                    phase: 'online',
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: Date.now(),
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                }),
                reportProbeResult,
            },
        });
    };

    beforeEach(() => {
        envScope = createEnvKeyScope([
            'HAPPIER_STACK_TOOL_TRACE',
            'HAPPIER_STACK_TOOL_TRACE_FILE',
            'HAPPIER_DAEMON_INITIAL_PROMPT',
            'HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED',
        ]);
        originalArgv = [...process.argv];
        vi.spyOn(console, 'log').mockImplementation(() => {});

        replaceSocketPair();

        mockSession = createMockSession({
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                happyHomeDir: '/home/user/.happy',
                happyLibDir: '/home/user/.happy/lib',
                happyToolsDir: '/home/user/.happy/tools',
            },
        });
    });

    afterEach(async () => {
        for (const client of createdClients.splice(0)) {
            if ((client as any).closed) {
                continue;
            }
            try {
                await client.close();
            } catch {
                // ignore
            }
        }

        process.argv = originalArgv;
        envScope.restore();
        __resetToolTraceForTests();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('clears accountIdPromise on failure so later calls can retry', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;

        const getSpy = vi
            .spyOn(axios, 'get')
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValueOnce({ data: { id: 'acc-1' } });

        const client = createClient('token', mockSession);

        const first = await (client as any).getAccountId();
        expect(first).toBeNull();

        const second = await (client as any).getAccountId();
        expect(second).toBe('acc-1');

        expect(getSpy).toHaveBeenCalledTimes(2);
    });

    it('exposes last observed transcript seq for fork/resume heuristics', () => {
        const client = createClient('token', mockSession);
        expect(client.getLastObservedMessageSeq()).toBe(0);
    });

    it('keeps execution.run.send RPC registered even when execution.runs is disabled', async () => {
        envScope.patch({ HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED: '0' });

        const client = createClient('token', mockSession);

        expect(client.rpcHandlerManager.hasHandler('execution.run.send')).toBe(true);

        const result = await client.rpcHandlerManager.invokeLocal('execution.run.send', {
            runId: 'run-1',
            message: 'hello',
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed' });
    });

    it('filters historical catch-up user messages from delivery for terminal-started sessions', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const { configuration } = await import('@/configuration');

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'historical prompt' },
            meta: { source: 'ui', sentFrom: 'web' },
        };
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue(
            buildMessagesListResponse([
                buildEncryptedTranscriptMessage({
                    session: mockSession,
                    plaintext,
                    id: 'm-old-1',
                    seq: 1,
                    createdAt:
                        Date.now() - configuration.startupTranscriptCatchUpLookbackMs - 1_000,
                }),
            ]),
        );

        removeStartedByArgvFlag();
        mockSession.metadata.startedBy = undefined;
        mockSession.metadata.startedFromDaemon = undefined;

        const client = createClient('token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        await waitForNextTick();
        expect(getSessionMessagesGetCalls(getSpy, mockSession.id).length).toBeGreaterThanOrEqual(1);
        expect(onUserMessage).not.toHaveBeenCalled();
    });

    it('filters historical catch-up user messages from delivery for daemon-started sessions', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const { configuration } = await import('@/configuration');

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'historical daemon prompt' },
            meta: { source: 'ui', sentFrom: 'web' },
        };
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue(
            buildMessagesListResponse([
                buildEncryptedTranscriptMessage({
                    session: mockSession,
                    plaintext,
                    id: 'm-daemon-old-1',
                    seq: 1,
                    createdAt:
                        Date.now() - configuration.startupTranscriptCatchUpLookbackMs - 1_000,
                }),
            ]),
        );

        mockSession.metadata.startedBy = 'daemon';

        const client = createClient('token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        await waitForNextTick();
        expect(getSessionMessagesGetCalls(getSpy, mockSession.id).length).toBeGreaterThanOrEqual(1);
        expect(onUserMessage).not.toHaveBeenCalled();
    });

    it('delivers historical daemon-initial-prompt catch-up messages for daemon-started respawns', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const { configuration } = await import('@/configuration');

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'recover daemon prompt after respawn' },
            meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
        };
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue(
            buildMessagesListResponse([
                buildEncryptedTranscriptMessage({
                    session: mockSession,
                    plaintext,
                    id: 'm-daemon-initial-prompt-old-1',
                    seq: 1,
                    createdAt:
                        Date.now() - configuration.startupTranscriptCatchUpLookbackMs - 1_000,
                }),
            ]),
        );

        mockSession.metadata.startedBy = 'daemon';

        const client = createClient('token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        await waitForNextTick();
        expect(getSessionMessagesGetCalls(getSpy, mockSession.id).length).toBeGreaterThanOrEqual(1);
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'user',
                content: { type: 'text', text: 'recover daemon prompt after respawn' },
                meta: expect.objectContaining({
                    source: 'daemon-initial-prompt',
                    sentFrom: 'cli',
                }),
            }),
        );
    });

    it('uses a deterministic localId for daemon initial prompt commits so respawn replays stay idempotent', async () => {
        envScope.patch({
            HAPPIER_DAEMON_INITIAL_PROMPT: 'recover daemon prompt after respawn',
        });

        configureCommittedMessageAck(mockSocket, {
            ok: true,
            id: 'msg-daemon-initial-prompt-1',
            seq: 1,
        });
        mockSession.metadata.startedBy = 'daemon';

        const client = createClient('token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);
        await flushClientQueue(client);

        const payload = getLastCommittedMessagePayload(mockSocket);
        expect(payload).toEqual(
            expect.objectContaining({
                sid: mockSession.id,
                localId: `daemon-initial-prompt:${mockSession.id}`,
            }),
        );
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                localId: `daemon-initial-prompt:${mockSession.id}`,
                meta: expect.objectContaining({
                    source: 'daemon-initial-prompt',
                    sentFrom: 'cli',
                }),
            }),
        );
    });

    it('delivers recent catch-up user messages for terminal-started sessions', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'recent prompt' },
            meta: { source: 'ui', sentFrom: 'web' },
        };
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue(
            buildMessagesListResponse([
                buildEncryptedTranscriptMessage({
                    session: mockSession,
                    plaintext,
                    id: 'm-new-1',
                    seq: 1,
                    createdAt: Date.now(),
                }),
            ]),
        );

        removeStartedByArgvFlag();
        mockSession.metadata.startedBy = undefined;
        mockSession.metadata.startedFromDaemon = undefined;

        const client = createClient('token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        await waitForNextTick();
        expect(getSessionMessagesGetCalls(getSpy, mockSession.id).length).toBeGreaterThanOrEqual(1);
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'user',
                content: { type: 'text', text: 'recent prompt' },
            }),
        );
    });

    it('delivers recent catch-up user messages for daemon-started sessions', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'recent daemon prompt' },
            meta: { source: 'ui', sentFrom: 'web' },
        };
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue(
            buildMessagesListResponse([
                buildEncryptedTranscriptMessage({
                    session: mockSession,
                    plaintext,
                    id: 'm-daemon-new-1',
                    seq: 1,
                    createdAt: Date.now(),
                }),
            ]),
        );

        mockSession.metadata.startedBy = 'daemon';

        const client = createClient('token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        await waitForNextTick();
        expect(getSessionMessagesGetCalls(getSpy, mockSession.id).length).toBeGreaterThanOrEqual(1);
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'user',
                content: { type: 'text', text: 'recent daemon prompt' },
            }),
        );
    });

    it('starts daemon startup transcript catch-up from the existing session seq', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;

        const existingSeq = 18;
        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'queued prompt after resume' },
            meta: { source: 'ui', sentFrom: 'web' },
        };

        const getSpy = vi.spyOn(axios, 'get').mockImplementation(async (...args: unknown[]) => {
            const [url, config] = args as [string, { params?: { afterSeq?: number } } | undefined];
            if (url.includes(`/v1/sessions/${mockSession.id}/messages`)) {
                expect(config?.params?.afterSeq).toBe(existingSeq);
                return buildMessagesListResponse([
                    buildEncryptedTranscriptMessage({
                        session: mockSession,
                        plaintext,
                        id: 'm-daemon-after-seq-1',
                        seq: existingSeq + 1,
                        createdAt: Date.now(),
                    }),
                ]);
            }
            throw new Error(`Unexpected axios.get: ${url}`);
        });

        mockSession.seq = existingSeq;
        mockSession.metadata.startedBy = 'daemon';

        const client = createClient('token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        await waitForNextTick();
        expect(getSessionMessagesGetCalls(getSpy, mockSession.id).length).toBeGreaterThanOrEqual(1);
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'user',
                content: { type: 'text', text: 'queued prompt after resume' },
            }),
        );
    });

    it('runs startup transcript catch-up for daemon-started sessions', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;

        const getSpy = vi
            .spyOn(axios, 'get')
            .mockResolvedValue(buildMessagesListResponse([]));

        mockSession.metadata.startedBy = 'daemon';

        const client = createClient('token', mockSession);
        client.onUserMessage(() => {});

        await waitForNextTick();
        expect(getSessionMessagesGetCalls(getSpy, mockSession.id).length).toBeGreaterThanOrEqual(1);
    });

    it('sends plaintext session messages when session.encryptionMode is plain', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', { ...mockSession, encryptionMode: 'plain' as const });

        client.sendUserTextMessage('hello');

        await flushClientQueue(client);

        expect(getLastCommittedMessagePayload(mockSocket)).toEqual(
            expect.objectContaining({
                sid: 'test-session-id',
                message: expect.objectContaining({ t: 'plain', v: expect.anything() }),
                localId: expect.any(String),
            }),
        );
    });

    it('normalizes outbound ACP tool-call names and inputs to V2 canonical keys', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);
        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'execute',
            input: { command: ['bash', '-lc', 'echo hi'] },
            id: 'msg-1',
        });

        await flushClientQueue(client);

        const decrypted = getLastDecryptedOutboundMessage(mockSession);

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.provider).toBe('opencode');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-call',
            name: 'Bash',
            input: expect.objectContaining({ command: 'echo hi' }),
        });
    });

    it('does not emit metadata-updated after close() when a snapshot sync resolves late', async () => {
        const snapshotSync = await import('./session/snapshotSync');

        let resolveFetch!: (value: any) => void;
        const fetchPromise = new Promise<any>((resolve) => {
            resolveFetch = resolve;
        });

        const fetchSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockReturnValue(fetchPromise as any);

        try {
            const client = createClient('fake-token', mockSession);
            const onMetadataUpdated = vi.fn();
            client.on('metadata-updated', onMetadataUpdated);

            const syncPromise = (client as any).syncSessionSnapshotFromServer({ reason: 'connect' });
            await client.close();

            resolveFetch({
                metadata: {
                    metadata: { ...mockSession.metadata, path: '/tmp/late' },
                    metadataVersion: mockSession.metadataVersion + 1,
                },
                agentState: null,
            });

            await syncPromise;
            expect(onMetadataUpdated).not.toHaveBeenCalled();
            expect(client.getMetadataSnapshot()?.path).toBe('/tmp');
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it.each([401, 403] as const)('reports session snapshot refresh auth status %i to the session supervisor', async (status) => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const reportProbeResult = vi.fn();
        const client = createClient('fake-token', mockSession);
        overrideSessionSupervisor(client, reportProbeResult);
        vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status,
            data: { error: 'not-authenticated' },
        });

        await (client as any).syncSessionSnapshotFromServer({ reason: 'connect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: status,
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
    });

    it('reports retryable session snapshot refresh failures to the session supervisor', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const reportProbeResult = vi.fn();
        const client = createClient('fake-token', mockSession);
        overrideSessionSupervisor(client, reportProbeResult);
        vi.spyOn(axios, 'get').mockResolvedValueOnce({
            status: 503,
            data: { error: 'busy' },
        });

        await (client as any).syncSessionSnapshotFromServer({ reason: 'connect' });

        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'retry_later',
            errorMessage: expect.any(String),
        } satisfies ReadinessProbeResult);
    });

    it('ensureMetadataSnapshot waits for a decrypted snapshot when starting with metadataVersion=-1', async () => {
        const snapshotSync = await import('./session/snapshotSync');

        mockSession.metadataVersion = -1;
        mockSession.agentStateVersion = -1;
        mockSession.metadata = { ...mockSession.metadata, path: '/tmp/local' };

        let resolveFetch!: (value: any) => void;
        const fetchPromise = new Promise<any>((resolve) => {
            resolveFetch = resolve;
        });

        const fetchSpy = vi
            .spyOn(snapshotSync, 'fetchSessionSnapshotUpdateFromServer')
            .mockReturnValue(fetchPromise as any);

        try {
            const client = createClient('fake-token', mockSession);

            let completed = false;
            const p = client.ensureMetadataSnapshot({ timeoutMs: 10_000 }).then((meta) => {
                completed = true;
                return meta;
            });

            await waitForNextTick();
            expect(completed).toBe(false);

            resolveFetch({
                metadata: {
                    metadata: { ...mockSession.metadata, path: '/tmp/remote' },
                    metadataVersion: 0,
                },
                agentState: null,
            });

            const meta = await p;
            expect(meta?.path).toBe('/tmp/remote');
            expect(client.getMetadataSnapshot()?.path).toBe('/tmp/remote');
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('backfills missing Read tool-call input details from permission-request toolCall.rawInput', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);

        client.sendAgentMessage('opencode', {
            type: 'permission-request',
            permissionId: 'call-1',
            toolName: 'read',
            description: 'read',
            options: {
                toolCall: {
                    rawInput: { filepath: '/etc/hosts' },
                },
            },
        });

        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'read',
            input: {
                locations: [],
                description: 'read',
                _acp: { kind: 'read', title: 'read', rawInput: {} },
            },
            id: 'msg-1',
        });

        await flushClientQueue(client);

        const decryptedToolCall = getDecryptedOutboundMessages(mockSession)
            .find((msg: any) => msg?.content?.type === 'acp' && msg?.content?.data?.type === 'tool-call');

        expect(decryptedToolCall).toBeTruthy();
        expect(decryptedToolCall.content.data).toMatchObject({
            type: 'tool-call',
            name: 'Read',
            input: expect.objectContaining({ file_path: '/etc/hosts' }),
        });
    });

    it('includes server-createdAt on delivered user messages so permission precedence can be timestamped', () => {
        const client = createClient('fake-token', mockSession);

        const received: any[] = [];
        client.onUserMessage((msg: any) => received.push(msg));

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { source: 'ui', sentFrom: 'e2e', permissionMode: 'read-only' },
        };

        const update = buildEncryptedSessionMessageUpdate({
            session: mockSession,
            updateId: 'u-1',
            seq: 1,
            messageId: 'm-1',
            plaintext,
            createdAt: 1234,
        });

        (client as any).handleUpdate(update, { source: 'session-scoped' });

        expect(received.length).toBe(1);
        expect(received[0]).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { permissionMode: 'read-only' },
            createdAt: 1234,
        });
    });

    it('delivers plaintext new-message updates without decrypting', () => {
        const client = createClient('fake-token', mockSession);

        const received: any[] = [];
        client.onUserMessage((msg: any) => received.push(msg));

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { source: 'ui', sentFrom: 'e2e', permissionMode: 'read-only' },
        };

        const update = {
            id: 'u-1',
            seq: 0,
            createdAt: 1234,
            body: {
                t: 'new-message',
                sid: mockSession.id,
                message: {
                    id: 'm-1',
                    seq: 1,
                    content: { t: 'plain', v: plaintext },
                },
            },
        };

        (client as any).handleUpdate(update, { source: 'session-scoped' });

        expect(received.length).toBe(1);
        expect(received[0]).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'hello' },
            meta: { permissionMode: 'read-only' },
            createdAt: 1234,
        });
    });

    it('consumes daemon initial prompt env and seeds one user prompt on callback attach', () => {
        envScope.patch({ HAPPIER_DAEMON_INITIAL_PROMPT: '  run nightly health check  ' });

        const client = createClient('fake-token', mockSession);
        const sendUserTextMessageSpy = vi.spyOn(client, 'sendUserTextMessage');
        const onUserMessage = vi.fn();

        client.onUserMessage(onUserMessage);
        client.onUserMessage(onUserMessage);

        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'user',
                content: { type: 'text', text: 'run nightly health check' },
                meta: expect.objectContaining({
                    source: 'daemon-initial-prompt',
                    sentFrom: 'cli',
                }),
            }),
        );
        expect(sendUserTextMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendUserTextMessageSpy).toHaveBeenCalledWith(
            'run nightly health check',
            expect.objectContaining({
                meta: {
                    source: 'daemon-initial-prompt',
                    sentFrom: 'cli',
                },
            }),
        );
        expect(process.env.HAPPIER_DAEMON_INITIAL_PROMPT).toBeUndefined();
    });

    it('routes session user-message RPC through the runtime queue and transcript commit path', async () => {
        configureCommittedMessageAck(mockSocket, {
            ok: true,
            id: 'msg-rpc-1',
            seq: 1,
            localId: 'rpc-local-1',
            didWrite: true,
        });

        const client = createClient('fake-token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const result = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
            text: 'hello from session send',
            localId: 'rpc-local-1',
            meta: {
                source: 'cli',
                sentFrom: 'cli',
                permissionMode: 'default',
            },
        });
        await flushClientQueue(client);

        expect(result).toEqual({ ok: true });
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                localId: 'rpc-local-1',
                content: { type: 'text', text: 'hello from session send' },
                meta: expect.objectContaining({
                    source: 'cli',
                    sentFrom: 'cli',
                    permissionMode: 'default',
                }),
            }),
        );
        expect(mockSocket.emitWithAck).toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: mockSession.id,
                localId: 'rpc-local-1',
                echoToSender: true,
            }),
        );
    });

    it('reuses one generated localId for queued RPC user messages and their transcript echo suppression', async () => {
        configureCommittedMessageAck(mockSocket, {
            ok: true,
            id: 'msg-rpc-2',
            seq: 2,
        });

        const client = createClient('fake-token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const result = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
            text: 'hello without explicit local id',
            meta: {
                source: 'cli',
                sentFrom: 'cli',
            },
        });
        await flushClientQueue(client);

        const emittedLocalId = String((mockSocket.emitWithAck.mock.calls[0]?.[1] as any)?.localId ?? '');
        expect(emittedLocalId).not.toBe('');
        expect(result).toEqual({ ok: true });
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                localId: emittedLocalId,
                content: { type: 'text', text: 'hello without explicit local id' },
            }),
        );

        const updateHandler = expectSocketHandler(mockSocket, 'update');

        emitEncryptedSessionMessageUpdate(mockSocket, {
            session: mockSession,
            updateId: 'update-rpc-2',
            seq: 2,
            messageId: 'msg-rpc-2',
            localId: emittedLocalId,
            plaintext: {
                role: 'user',
                content: { type: 'text', text: 'hello without explicit local id' },
                localId: emittedLocalId,
                meta: { sentFrom: 'cli', source: 'cli' },
            },
        });

        expect(onUserMessage).toHaveBeenCalledTimes(1);
    });

    it('preserves whitespace in queued RPC user messages', async () => {
        configureCommittedMessageAck(mockSocket, {
            ok: true,
            id: 'msg-rpc-3',
            seq: 3,
            localId: 'rpc-local-3',
        });

        const client = createClient('fake-token', mockSession);
        const onUserMessage = vi.fn();
        client.onUserMessage(onUserMessage);

        const text = '  keep trailing newline\n';
        const result = await client.rpcHandlerManager.invokeLocal(SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND, {
            text,
            localId: 'rpc-local-3',
            meta: {
                source: 'cli',
                sentFrom: 'cli',
            },
        });
        await flushClientQueue(client);

        expect(result).toEqual({ ok: true });
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                localId: 'rpc-local-3',
                content: { type: 'text', text },
            }),
        );
    });

    it('runs one transcript catch-up on first callback attach to recover missed CLI startup user messages', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const createdAt = Date.now();

        const plaintext = {
            role: 'user',
            content: { type: 'text', text: 'missed startup prompt' },
            meta: { source: 'cli', sentFrom: 'cli' },
        };
        const getSpy = vi.spyOn(axios, 'get').mockResolvedValue(
            buildMessagesListResponse([
                buildEncryptedTranscriptMessage({
                    session: mockSession,
                    plaintext,
                    id: 'm-catchup-1',
                    seq: 1,
                    createdAt,
                }),
            ]),
        );

        mockSession.metadata = {
            ...mockSession.metadata,
            startedBy: 'daemon',
        };
        const client = createClient('fake-token', mockSession);
        const onUserMessage = vi.fn();

        client.onUserMessage(onUserMessage);
        await waitForNextTick();
        client.onUserMessage(onUserMessage);
        await waitForNextTick();

        expect(getSessionMessagesGetCalls(getSpy, mockSession.id).length).toBeGreaterThanOrEqual(1);
        expect(onUserMessage).toHaveBeenCalledTimes(1);
        expect(onUserMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                role: 'user',
                content: { type: 'text', text: 'missed startup prompt' },
                createdAt,
            }),
        );

        getSpy.mockRestore();
    });

    it('retries startup transcript catch-up when the first poll races before the first CLI user prompt commit', async () => {
        vi.useFakeTimers();
        try {
            const axiosMod = await import('axios');
            const axios = axiosMod.default as any;
            const createdAt = Date.now();

            const plaintext = {
                role: 'user',
                content: { type: 'text', text: 'missed by first poll, recovered by retry' },
                meta: { source: 'cli', sentFrom: 'cli' },
            };
            const getSpy = vi.spyOn(axios, 'get')
                .mockResolvedValueOnce(buildMessagesListResponse([]))
                .mockResolvedValueOnce(
                    buildMessagesListResponse([
                        buildEncryptedTranscriptMessage({
                            session: mockSession,
                            plaintext,
                            id: 'm-catchup-race-1',
                            seq: 1,
                            createdAt,
                        }),
                    ]),
                );

            mockSession.metadata = {
                ...mockSession.metadata,
                startedBy: 'daemon',
            };
            const client = createClient('fake-token', mockSession);
            const onUserMessage = vi.fn();

            client.onUserMessage(onUserMessage);

            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(5_000);

            expect(getSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(onUserMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    role: 'user',
                    content: { type: 'text', text: 'missed by first poll, recovered by retry' },
                    createdAt,
                }),
            );

            getSpy.mockRestore();
        } finally {
            vi.useRealTimers();
        }
    });

    it('can resolve the latest permission intent from the encrypted transcript (legacy tokens supported)', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;

        const client = createClient('fake-token', mockSession);

        const newerUser = {
            role: 'user',
            content: { type: 'text', text: 'hi' },
            meta: { source: 'ui', sentFrom: 'e2e', permissionMode: 'acceptEdits' },
        };
        const olderUser = {
            role: 'user',
            content: { type: 'text', text: 'older' },
            meta: { source: 'ui', sentFrom: 'e2e', permissionMode: 'read-only' },
        };

        const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
            data: {
                messages: [
                    buildEncryptedTranscriptMessage({
                        session: mockSession,
                        plaintext: newerUser,
                        createdAt: 200,
                    }),
                    buildEncryptedTranscriptMessage({
                        session: mockSession,
                        plaintext: olderUser,
                        createdAt: 100,
                    }),
                ],
            },
        });

        const res = await client.fetchLatestUserPermissionIntentFromTranscript({ take: 25 });
        expect(res).toEqual({ intent: 'safe-yolo', updatedAt: 200 });
        expect(getSpy.mock.calls[0]?.[0]).toContain(`/v1/sessions/${mockSession.id}/messages`);
        expect(getSpy.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ params: { limit: 25 } }));

        getSpy.mockRestore();
    });

    it('reports ACP import transcript auth failures to the session supervisor', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const authError = new HttpStatusError(401, 'expired token');
        const reportProbeResult = vi.fn();
        const client = createClient('fake-token', mockSession);
        overrideSessionSupervisor(client, reportProbeResult);
        vi.spyOn(axios, 'get').mockRejectedValueOnce(authError);

        await expect(client.fetchRecentTranscriptTextItemsForAcpImport({ take: 10 })).rejects.toBe(authError);
        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: 401,
            errorMessage: 'expired token',
        });
    });

    it('reports permission intent transcript auth failures to the session supervisor', async () => {
        const axiosMod = await import('axios');
        const axios = axiosMod.default as any;
        const authError = new HttpStatusError(403, 'forbidden');
        const reportProbeResult = vi.fn();
        const client = createClient('fake-token', mockSession);
        overrideSessionSupervisor(client, reportProbeResult);
        vi.spyOn(axios, 'get').mockRejectedValueOnce(authError);

        await expect(client.fetchLatestUserPermissionIntentFromTranscript({ take: 10 })).rejects.toBe(authError);
        expect(reportProbeResult).toHaveBeenCalledWith({
            status: 'auth_failed',
            statusCode: 403,
            errorMessage: 'forbidden',
        });
    });

    it('normalizes outbound ACP permission-request toolName to V2 canonical keys (supports TodoWrite)', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);

        client.sendAgentMessage('gemini', {
            type: 'permission-request',
            permissionId: 'write_todos-1',
            toolName: 'write',
            description: 'write',
            options: {},
        });

        await flushClientQueue(client);

        const decrypted = getLastDecryptedOutboundMessage(mockSession);

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.data).toMatchObject({
            type: 'permission-request',
            toolName: 'TodoWrite',
        });
    });

    it('backfills missing permission-request input details from nested options.toolCall.content (Gemini ACP)', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);

        client.sendAgentMessage('gemini', {
            type: 'permission-request',
            permissionId: 'replace-1',
            toolName: 'edit',
            description: 'edit',
            options: {
                options: {
                    toolCall: {
                        kind: 'edit',
                        title: 'Editing /tmp/a.txt',
                        locations: [{ path: '/tmp/a.txt' }],
                        content: [{ path: 'a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
                    },
                    input: {},
                },
            },
        });

        await flushClientQueue(client);

        const decrypted = getLastDecryptedOutboundMessage(mockSession);

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.provider).toBe('gemini');
        expect(decrypted.content.data.type).toBe('permission-request');
        expect(decrypted.content.data.options).toMatchObject({
            options: {
                input: {
                    items: [{ path: 'a.txt', oldText: 'hello', newText: 'hi', type: 'diff' }],
                },
            },
        });
    });

    it('normalizes outbound ACP tool-result outputs using the canonical tool name for the callId', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);

        client.sendAgentMessage('opencode', {
            type: 'tool-call',
            callId: 'call-1',
            name: 'execute',
            input: { command: ['bash', '-lc', 'echo hi'] },
            id: 'msg-1',
        });

        client.sendAgentMessage('opencode', {
            type: 'tool-result',
            callId: 'call-1',
            output: 'TRACE_OK\n',
            id: 'msg-2',
        });

        await flushClientQueue(client);

        const messages = getDecryptedOutboundMessages(mockSession);
        expect(messages).toHaveLength(2);
        const decrypted = messages[1];

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-result',
            callId: 'call-1',
            output: expect.objectContaining({
                stdout: 'TRACE_OK\n',
                _happier: expect.objectContaining({ v: 2, canonicalToolName: 'Bash' }),
                _raw: expect.anything(),
            }),
        });
    });

    it('backfills empty TodoWrite tool-result outputs with the requested todos', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);

        client.sendAgentMessage('gemini', {
            type: 'tool-call',
            callId: 'write_todos-1',
            name: 'write',
            input: { todos: [{ content: 'a', status: 'pending' }] },
            id: 'msg-1',
        });

        client.sendAgentMessage('gemini', {
            type: 'tool-result',
            callId: 'write_todos-1',
            output: [],
            id: 'msg-2',
        });

        await flushClientQueue(client);

        const messages = getDecryptedOutboundMessages(mockSession);
        expect(messages).toHaveLength(2);
        const decrypted = messages[1];

        expect(decrypted.content.type).toBe('acp');
        expect(decrypted.content.provider).toBe('gemini');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-result',
            callId: 'write_todos-1',
            output: expect.objectContaining({
                todos: [{ content: 'a', status: 'pending' }],
            }),
        });
    });

    it('normalizes outbound Codex MCP tool-call names to V2 canonical keys', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);
        client.sendCodexMessage({
            type: 'tool-call',
            callId: 'call-1',
            name: 'CodexBash',
            input: { command: ['bash', '-lc', 'echo hi'] },
            id: 'msg-1',
        });

        await flushClientQueue(client);

        const decrypted = getLastDecryptedOutboundMessage(mockSession);

        expect(decrypted.content.type).toBe('codex');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-call',
            name: 'Bash',
        });
    });

    it('normalizes outbound Codex MCP tool-call-result outputs using the canonical tool name for the callId', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);

        client.sendCodexMessage({
            type: 'tool-call',
            callId: 'call-1',
            name: 'CodexBash',
            input: { command: ['bash', '-lc', 'echo hi'] },
            id: 'msg-1',
        });

        client.sendCodexMessage({
            type: 'tool-call-result',
            callId: 'call-1',
            output: { stdout: 'TRACE_OK\n', exit_code: 0 },
            id: 'msg-2',
        });

        await flushClientQueue(client);

        const messages = getDecryptedOutboundMessages(mockSession);
        expect(messages).toHaveLength(2);
        const decrypted = messages[1];

        expect(decrypted.content.type).toBe('codex');
        expect(decrypted.content.data).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-1',
            output: expect.objectContaining({
                stdout: 'TRACE_OK\n',
                _happier: expect.objectContaining({ v: 2, canonicalToolName: 'Bash' }),
                _raw: expect.anything(),
            }),
        });
    });

    it('should handle socket connection failure gracefully', async () => {
        // Should not throw during client creation
        // Note: socket is created with autoConnect: false, so connection happens later
        expect(() => {
            createClient('fake-token', mockSession);
        }).not.toThrow();
    });

    it('registers the session-scoped RPC and update handlers on the supervised socket', () => {
        const client = createClient('fake-token', mockSession);

        expect(mockSocket.on).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('update', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('session', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('connect_error', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('close tears down the supervised session socket and closes the user-scoped socket', async () => {
        const client = createClient('fake-token', mockSession);

        await client.close();

        expect(mockSocket.disconnect).toHaveBeenCalledTimes(1);
        expect(mockSocket.removeAllListeners).toHaveBeenCalledTimes(1);
        expect(mockUserSocket.close).toHaveBeenCalledTimes(1);
    });

    it('waitForMetadataUpdate ensures the user-scoped socket is connected so metadata updates can wake idle agents', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);

        const controller = new AbortController();
        const promise = startMetadataWait(client, controller.signal);

        expect(mockUserSocket.connect).toHaveBeenCalledTimes(1);

        controller.abort();
        await expect(promise).resolves.toBe(false);
    });

    it('queues outbound messages while disconnected and flushes them after reconnect', async () => {
        replaceSocketPair({
            sessionSocket: createConfiguredSocket({
                connected: false,
                emitWithAckResult: {
                    ok: true,
                    id: 'msg-1',
                    seq: 1,
                    localId: 'queued-local-id',
                },
            }),
            userSocket: mockUserSocket,
        });

        const client = createClient('fake-token', mockSession);

        const payload: RawJSONLines = {
            type: 'user',
            uuid: 'test-uuid',
            message: {
                content: 'hello',
            },
        } as const;

        client.sendClaudeSessionMessage(payload);
        await flushClientQueue(client);

        expect(mockSocket.emit).not.toHaveBeenCalledWith(
            'message',
            expect.objectContaining({
                sid: mockSession.id,
            }),
        );
        expect(mockSocket.emitWithAck).not.toHaveBeenCalled();

        mockSocket.connected = true;
        mockSocket.trigger('connect');

        await vi.waitFor(() => {
            expect(getLastCommittedMessagePayload(mockSocket)).toEqual(
                expect.objectContaining({
                    sid: mockSession.id,
                    message: expect.any(String),
                    localId: expect.any(String),
                }),
            );
        });
    });

    it('merges optional meta into outbound Claude session messages', async () => {
        connectSessionSocket();
        const client = createClient('fake-token', mockSession);

        const payload: RawJSONLines = {
            type: 'assistant',
            uuid: 'test-uuid',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'hi' }],
            },
        } as const;

        client.sendClaudeSessionMessage(payload, { importedFrom: 'claude-taskoutput' });

        await flushClientQueue(client);

        const decrypted = getLastDecryptedOutboundMessage(mockSession);

        expect(decrypted.meta).toMatchObject({
            sentFrom: 'cli',
            source: 'cli',
            importedFrom: 'claude-taskoutput',
        });
    });

    it('does not emit unhandledRejection when summary metadata persistence rejects', async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
            const sessionSocket = createConfiguredSocket({
                connected: true,
                emitWithAck: async (event) => {
                    if (event === 'update-metadata') {
                        return { result: 'error', error: 'metadata unavailable' };
                    }
                    return { ok: true, id: 'msg-1', seq: 1, localId: 'local-1' };
                },
            });
            replaceSocketPair({ sessionSocket });

            const client = createClient('fake-token', mockSession);
            client.sendClaudeSessionMessage({
                type: 'summary',
                uuid: 'summary-1',
                summary: 'summary text',
                leafUuid: 'leaf-1',
            } as RawJSONLines);

            await flushClientQueue(client);
            await new Promise((resolve) => setImmediate(resolve));

            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('sends keepAlive(thinking=true) as a non-volatile emit so UIs that connect mid-turn still receive it', () => {
        connectSessionSocket();
        mockSocket.volatile = { emit: vi.fn() };

        const client = createClient('fake-token', mockSession);
        client.keepAlive(true, 'remote');

        expect(getSocketEventCalls(mockSocket, 'session-alive')).toEqual([
            [
                'session-alive',
                expect.objectContaining({ sid: mockSession.id, thinking: true, mode: 'remote' }),
            ],
        ]);
        expect(getSocketVolatileEventCalls(mockSocket, 'session-alive')).toHaveLength(0);
    });

    it('sends keepAlive(thinking=false) via volatile emit to avoid backpressure', () => {
        connectSessionSocket();
        mockSocket.volatile = { emit: vi.fn() };

        const client = createClient('fake-token', mockSession);
        client.keepAlive(false, 'remote');

        expect(getSocketVolatileEventCalls(mockSocket, 'session-alive')).toEqual([
            [
                'session-alive',
                expect.objectContaining({ sid: mockSession.id, thinking: false, mode: 'remote' }),
            ],
        ]);
    });

		    it('attaches server localId onto decrypted user messages', async () => {
		        const client = createClient('fake-token', mockSession);

	        const onUserMessage = vi.fn();
	        client.onUserMessage(onUserMessage);

        emitEncryptedSessionMessageUpdate(mockSocket, {
            session: mockSession,
            updateId: 'update-1',
            seq: 1,
            messageId: 'msg-1',
            localId: 'local-1',
            plaintext: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                meta: { sentFrom: 'web' },
            },
        });

		        expect(onUserMessage).toHaveBeenCalledWith(
		            expect.objectContaining({
		                content: expect.objectContaining({ text: 'hello' }),
		                localId: 'local-1',
		            }),
		        );
		    });

        it('delivers UI user messages from user-scoped updates even when not materialized locally', async () => {
            const client = createClient('fake-token', mockSession);

            const onUserMessage = vi.fn();
            client.onUserMessage(onUserMessage);

            emitEncryptedSessionMessageUpdate(mockUserSocket, {
                session: mockSession,
                updateId: 'update-ui-1',
                seq: 1,
                messageId: 'msg-ui-1',
                localId: 'local-ui-1',
                plaintext: {
                    role: 'user',
                    content: { type: 'text', text: 'hello from ui' },
                    localId: 'local-ui-1',
                    meta: { source: 'ui', sentFrom: 'e2e' },
                },
            });

            expect(onUserMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.objectContaining({ text: 'hello from ui' }),
                    localId: 'local-ui-1',
                }),
            );
        });

        it('does not emit user-message events when committing outbound CLI user messages (ACK is not a prompt)', async () => {
            const sessionSocket = createConfiguredSocket({
                connected: true,
                emitWithAckResult: {
                    ok: true,
                    id: 'msg-1',
                    seq: 1,
                    localId: 'local-1',
                },
            });
            const userSocket = createConfiguredSocket({ connected: false });
            replaceSocketPair({ sessionSocket, userSocket });

            const client = createClient('fake-token', mockSession);

            const onUserMessageEvent = vi.fn();
            client.on('user-message', onUserMessageEvent);

            await client.sendUserTextMessageCommitted('hello', { localId: 'local-1' });

            expect(onUserMessageEvent).not.toHaveBeenCalled();
        });

        it('delivers CLI-sent user messages from another client to onUserMessage callback', async () => {
            const client = createClient('fake-token', mockSession);

            const onUserMessage = vi.fn();
            client.onUserMessage(onUserMessage);

            emitEncryptedSessionMessageUpdate(mockSocket, {
                session: mockSession,
                updateId: 'update-2',
                seq: 2,
                messageId: 'msg-2',
                localId: 'local-2',
                plaintext: {
                    role: 'user',
                    content: { type: 'text', text: 'hello from cli' },
                    meta: { sentFrom: 'cli' },
                },
            });

            expect(onUserMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.objectContaining({ text: 'hello from cli' }),
                    localId: 'local-2',
                }),
            );
        });

        it('does not deliver self-sent CLI user messages while awaiting their echo update', async () => {
            configureCommittedMessageAck(mockSocket, {
                ok: true,
                id: 'msg-2',
                seq: 2,
                localId: 'local-2',
            });

            const client = createClient('fake-token', mockSession);

            const onUserMessage = vi.fn();
            client.onUserMessage(onUserMessage);

            await client.sendUserTextMessageCommitted('hello from cli', { localId: 'local-2' });

            emitEncryptedSessionMessageUpdate(mockSocket, {
                session: mockSession,
                updateId: 'update-2',
                seq: 2,
                messageId: 'msg-2',
                localId: 'local-2',
                plaintext: {
                    role: 'user',
                    content: { type: 'text', text: 'hello from cli' },
                    meta: { sentFrom: 'cli' },
                },
            });

            expect(onUserMessage).not.toHaveBeenCalled();
        });

    it('waitForMetadataUpdate resolves when session metadata updates', async () => {
        const client = createClient('fake-token', mockSession);

        const waitPromise = startMetadataWait(client);

        emitMetadataWakeUpdate({
            session: mockSession,
            path: '/tmp/next',
            updateId: 'update-2',
            seq: 2,
        });

        await expect(waitPromise).resolves.toBe(true);
    });

    it('waitForMetadataUpdate resolves when the user-scoped socket connects (wakes idle agents)', async () => {
        const client = createClient('fake-token', mockSession);

        const waitPromise = startMetadataWait(client);

        triggerLastUserSocketLifecycleEvent('connect');
        await expect(waitPromise).resolves.toBe(true);
    });

    it('waitForMetadataUpdate syncs a session snapshot on user-scoped connect so missed metadata updates are observed', async () => {
        const client = createClient('fake-token', mockSession);

        const syncSpy = stubMetadataSnapshotWake(client, {
            path: '/tmp/from-sync',
            waitForTick: true,
        });

        const waitPromise = startMetadataWait(client);

        triggerLastUserSocketLifecycleEvent('connect');

        await expect(waitPromise).resolves.toBe(true);
        expect(syncSpy).toHaveBeenCalled();
        expect(client.getMetadataSnapshot()?.path).toBe('/tmp/from-sync');
    });

    it('waitForMetadataUpdate resolves when session metadata updates (server sends update-session with id)', async () => {
        const client = createClient('fake-token', mockSession);

        const waitPromise = startMetadataWait(client);

        emitMetadataWakeUpdate({
            session: mockSession,
            path: '/tmp/next2',
            updateId: 'update-2b',
            seq: 3,
            idField: 'id',
        });

        await expect(waitPromise).resolves.toBe(true);
    });

    it('waitForMetadataUpdate resolves false when user-scoped socket disconnects', async () => {
        const client = createClient('fake-token', mockSession);

        const waitPromise = startMetadataWait(client);

        triggerLastUserSocketLifecycleEvent('disconnect');
        await expect(waitPromise).resolves.toBe(false);
    });

    it('waitForMetadataUpdate does not miss fast user-scoped update-session wakeups', async () => {
        const client = createClient('fake-token', mockSession);

        mockUserSocket.connect.mockImplementation(() => {
            emitMetadataWakeUpdate({
                session: mockSession,
                socket: mockUserSocket,
                path: '/tmp/fast',
                updateId: 'update-fast',
                seq: 999,
                version: 2,
            });
        });

        const controller = new AbortController();
        const promise = startMetadataWait(client, controller.signal);

        queueMicrotask(() => controller.abort());
        await expect(promise).resolves.toBe(true);
    });

    it('waitForMetadataUpdate does not miss snapshot sync updates started before handlers attach', async () => {
        const client = createClient('fake-token', mockSession);

        (client as any).metadataVersion = -1;
        (client as any).agentStateVersion = -1;
        stubMetadataSnapshotWake(client);

        const promise = startMetadataWait(client);
        await expect(
            Promise.race([
                promise,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('waitForMetadataUpdate() hung after snapshot sync')), 50)
                )
            ])
        ).resolves.toBe(true);
    });

    it('updateMetadata syncs a snapshot first when metadataVersion is unknown', async () => {
                const sessionSocket = createConfiguredSocket({ connected: false });
                const userSocket = createConfiguredSocket({ connected: false });

                const serverMetadata = {
                    ...mockSession.metadata,
                    tools: ['tool-1'],
                };
                const encryptedServerMetadata = encryptSessionValue(
                    mockSession,
                    serverMetadata,
                );

                const emitWithAck = vi.fn().mockResolvedValueOnce({
                    result: 'success',
                    version: 6,
                    metadata: encryptedServerMetadata,
                });
                sessionSocket.emitWithAck = emitWithAck;

                replaceSocketPair({ sessionSocket, userSocket });

                const axiosMod = await import('axios');
                const axios = axiosMod.default as any;
                vi.spyOn(axios, 'get').mockResolvedValue(
                    buildServerSessionSnapshotResponse({
                        session: mockSession,
                        metadataVersion: 5,
                        metadata: encryptedServerMetadata,
                    }),
                );

                const client = createClient('fake-token', {
                    ...mockSession,
                    metadataVersion: -1,
                    metadata: {
                        ...mockSession.metadata,
                        tools: [],
                    },
                });

                await client.updateMetadata((metadata) => {
                    return metadata;
                });

                expect(emitWithAck).toHaveBeenCalledWith(
                    'update-metadata',
                    expect.objectContaining({ expectedVersion: 5 }),
                );
    });

});
