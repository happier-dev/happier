import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
    AgentSessionRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { createJiti } from 'jiti';
import { describe, expect, it, vi } from 'vitest';

import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { createSessionClientTranscriptApi } from '@/api/session/client/transcript/sessionClientTranscriptApi';
import { createRuntimeSessionClientDurableMutationOutbox } from '@/api/session/client/transport/mutations/createRuntimeSessionClientDurableMutationOutbox';
import { createTranscriptMessageAppendMutation } from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import { loadSessionClientDurableMutationOutbox } from '@/api/session/client/transport/mutations/sessionClientDurableMutationPersistence';
import { projectRuntimeTranscriptEvent } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';

import {
    createNativeAgentSessionHostServices,
    createNativeAgentSessionOperations,
} from './nativeAgentSession';

type CompositionSocket = {
    connected: boolean;
    emit: (event: string, payload: unknown, callback?: (answer: unknown) => void) => void;
    emitWithAck: (event: string, payload: unknown) => Promise<unknown>;
    timeout: (ms: number) => CompositionSocket;
};

type CreateCodexNativeSession = (
    appServer: unknown,
    sessionId: string,
) => AgentSessionRuntime;

type CreateClaudeNativeSession = (
    operations: unknown,
    request: unknown,
) => AgentSessionRuntime;

type ProviderComposition = Readonly<{
    agentId: 'codex' | 'claude';
    assistantText: string;
    session: AgentSessionRuntime;
    publishSemanticSessionEvent?: () => Promise<unknown>;
}>;

async function loadPluginExport<T>(
    relativeRepoPath: string,
    exportName: string,
): Promise<T> {
    const loader = createJiti(import.meta.url, {
        fsCache: false,
        moduleCache: true,
        interopDefault: false,
    });
    const module = await loader.import(resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../../../',
        relativeRepoPath,
    )) as Readonly<Record<string, unknown>>;
    const value = module[exportName];
    if (typeof value !== 'function') {
        throw new Error(`Real plugin export '${exportName}' is unavailable`);
    }
    return value as T;
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }
    process.env[name] = value;
}

function createTranscriptApi(params: Readonly<{
    sessionId: string;
    socket: CompositionSocket;
    outbox: ReturnType<typeof createRuntimeSessionClientDurableMutationOutbox>;
}>) {
    return createSessionClientTranscriptApi({
        token: 'composition-token',
        sessionId: params.sessionId,
        outboundShapeLogger: { log: vi.fn() },
        getSocket: () => params.socket,
        getLatestTurnSnapshot: () => null,
        getActiveLocalTurnProgressAt: () => null,
        getSessionConnectionSupervisor: () => null,
        getMetadataSnapshot: () => null,
        updateAgentState: vi.fn(async () => undefined),
        updateMetadata: vi.fn(async () => undefined),
        enqueueCommittedTranscriptMessage: (message) => (
            params.outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
                sessionId: params.sessionId,
                localId: message.localId,
                content: message.message,
                sidechainId: message.sidechainId,
                messageRole: message.messageRole,
                sessionEventType: message.sessionEventType,
                createdAt: message.createdAt,
                updatedAt: message.updatedAt,
                provenance: message.provenance,
            }))
        ),
        enqueueCommittedVoiceAgentTranscriptTurn: vi.fn(async () => ({
            persisted: true,
            delivered: false,
        })),
        usageObservationPublisher: { publish: vi.fn(async () => undefined) },
        buildOutboundSessionMessagePayload: (content) => ({ t: 'plain', v: content }),
        toolCallCanonicalNameByProviderAndId: new Map(),
        permissionToolCallRawInputByProviderAndId: new Map(),
        toolCallInputByProviderAndId: new Map(),
        admitSessionUserMessage: vi.fn(async () => undefined),
        getTranscriptQueryContext: () => ({ encryptionMode: 'plain' }),
    });
}

async function createCodexComposition(sessionId: string): Promise<ProviderComposition> {
    const createSession = await loadPluginExport<CreateCodexNativeSession>(
        'packages/plugins/codex/src/agent/runtime/appServer/native.ts',
        'createCodexNativeAppServerSessionRuntime',
    );
    const listeners = new Set<(event: Readonly<Record<string, unknown>>) => void>();
    const publish = (event: Readonly<Record<string, unknown>>): void => {
        for (const listener of listeners) listener(event);
    };
    const assistantText = 'Codex output retained across disconnect';
    const appServer = {
        identity: { read: () => ({ providerSessionId: null }) },
        events: {
            subscribe(listener: (event: Readonly<Record<string, unknown>>) => void) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        },
        async send(_input: unknown, options?: Readonly<{ turnId?: string }>) {
            const turnId = options?.turnId ?? 'turn-codex';
            const emittedAtMs = Date.now();
            publish({ kind: 'turn-start', sessionId, turnId, emittedAtMs, startedBy: 'host' });
            publish({
                kind: 'message-delta',
                sessionId,
                turnId,
                emittedAtMs: emittedAtMs + 1,
                delta: { text: assistantText },
            });
            publish({
                kind: 'tool-call',
                sessionId,
                turnId,
                emittedAtMs: emittedAtMs + 2,
                toolCallId: 'codex-tool-1',
                toolName: 'read_file',
                toolInput: { path: '/tmp/codex-proof.txt' },
            });
            publish({
                kind: 'tool-result',
                sessionId,
                turnId,
                emittedAtMs: emittedAtMs + 3,
                toolCallId: 'codex-tool-1',
                output: { text: 'codex tool output' },
            });
            publish({ kind: 'turn-complete', sessionId, turnId, emittedAtMs: emittedAtMs + 4 });
            return { status: 'accepted', turnId };
        },
        async cancel() { return { status: 'cancelled' }; },
        async updateConfig() { return undefined; },
        async rollbackNativeConversation() { return { status: 'notApplied' }; },
        async reconcileNativeConversationRollback() { return { status: 'notApplied' }; },
        async dispose() { return undefined; },
    };
    return {
        agentId: 'codex',
        assistantText,
        session: createSession(appServer, sessionId),
    };
}

async function createClaudeComposition(params: Readonly<{
    sessionId: string;
    publishSemanticSessionEvent: () => Promise<unknown>;
}>): Promise<ProviderComposition> {
    const createSession = await loadPluginExport<CreateClaudeNativeSession>(
        'packages/plugins/claude/src/agent/runtime/nativeRuntime.ts',
        'createClaudeNativeSessionRuntimeFromOperations',
    );
    const listeners = new Set<(event: Readonly<Record<string, unknown>>) => void>();
    const publish = (event: Readonly<Record<string, unknown>>): void => {
        for (const listener of listeners) listener(event);
    };
    const assistantText = 'Claude output retained across disconnect';
    const operations = {
        subscribeEffectiveModel: () => () => undefined,
        subscribeRuntimeEvents: () => () => undefined,
        subscribeProviderEvents(listener: (event: Readonly<Record<string, unknown>>) => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        beginProviderTurn: () => undefined,
        startProviderSession: async () => null,
        async sendProviderTurnPrompt() {
            const turnId = 'turn-claude';
            const emittedAtMs = Date.now();
            publish({ kind: 'turn-start', sessionId: params.sessionId, turnId, emittedAtMs, startedBy: 'host' });
            publish({
                kind: 'message-delta',
                sessionId: params.sessionId,
                turnId,
                emittedAtMs: emittedAtMs + 1,
                delta: { text: assistantText },
            });
            publish({
                kind: 'tool-call',
                sessionId: params.sessionId,
                turnId,
                emittedAtMs: emittedAtMs + 2,
                toolCallId: 'claude-tool-1',
                toolName: 'read_file',
                toolInput: { path: '/tmp/claude-proof.txt' },
            });
            publish({
                kind: 'tool-result',
                sessionId: params.sessionId,
                turnId,
                emittedAtMs: emittedAtMs + 3,
                toolCallId: 'claude-tool-1',
                output: { text: 'claude tool output' },
            });
            publish({ kind: 'turn-complete', sessionId: params.sessionId, turnId, emittedAtMs: emittedAtMs + 4 });
            return { kind: 'accepted' };
        },
        steerProviderTurn: async () => ({ kind: 'accepted' }),
        waitForProviderTurnCompletion: async () => undefined,
        respondToProviderPermission: async () => ({ delivered: true }),
        cancelProviderTurn: async () => undefined,
        readProviderIdentity: () => ({ sessionId: null }),
        updateProviderConfiguration: async () => ({ status: 'applied' }),
        disposeProviderSession: async () => undefined,
    };
    return {
        agentId: 'claude',
        assistantText,
        session: createSession(operations, {
            kind: 'create',
            sessionId: params.sessionId,
            cwd: '/tmp/claude-composition',
            configuration: {
                mode: { value: null, updatedAtMs: 0 },
                model: { value: null, updatedAtMs: 0 },
                permissionIntent: { value: null, updatedAtMs: 0 },
                options: {},
            },
        }),
        publishSemanticSessionEvent: params.publishSemanticSessionEvent,
    };
}

describe('hosted native Agent disconnected transcript composition', () => {
    it.each(['codex', 'claude'] as const)(
        'retains real %s native output and settles exact transcript ACKs after reconnect',
        async (agentId) => {
            const sessionId = `native-disconnected-${agentId}-${randomUUID()}`;
            const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            const originalMaxRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
            const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            const originalDeliveryConcurrency = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY;
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = '60000';
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
            process.env.HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY = '1';

            const socketEmit = vi.fn();
            const deliveryLocalIds: string[] = [];
            let loseNextAck = true;
            const socket: CompositionSocket = {
                connected: false,
                emit: socketEmit,
                emitWithAck: vi.fn(async (_event, payload) => {
                    const localId = (payload as Readonly<{ localId?: unknown }>).localId;
                    if (typeof localId !== 'string') throw new Error('Expected transcript localId');
                    deliveryLocalIds.push(localId);
                    if (loseNextAck) {
                        loseNextAck = false;
                        return undefined;
                    }
                    return {
                        ok: true,
                        status: 'observed',
                        id: `message-${deliveryLocalIds.length}`,
                        seq: deliveryLocalIds.length,
                        localId,
                        didWrite: true,
                        didUpdate: false,
                        ingestedAt: Date.now(),
                    };
                }),
                timeout() { return socket; },
            };
            const outbox = createRuntimeSessionClientDurableMutationOutbox({
                token: 'composition-token',
                sessionId,
                flushOnReady: false,
                getSocket: () => socket,
                requestReconnect: vi.fn(),
            });
            const transcriptApi = createTranscriptApi({ sessionId, socket, outbox });
            const transcriptSession = {
                sessionId,
                ...transcriptApi,
                updateMetadata: vi.fn(async () => undefined),
            };
            const hostServices = createNativeAgentSessionHostServices({
                owners: {
                    features: { isEnabled: () => false },
                    sessionHooks: {},
                    transcripts: { fileFollow: {} },
                    accountUsage: {},
                    mcp: {},
                    toolExecution: {},
                },
                agentId,
                sessionId,
                directory: `/tmp/${sessionId}`,
                signal: new AbortController().signal,
                isCurrent: () => true,
                session: transcriptSession,
                publications: {
                    models: { bind: () => ({ dispose() {} }) },
                    activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
                },
                readToolExecutionCapability: () => null,
            } as never);
            const semanticEvent = {
                type: 'runtime-config-outcome' as const,
                agentId: 'claude',
                runtime: 'claude-unified-terminal',
                status: 'applied' as const,
                message: 'Claude native configuration was applied.',
                changes: [{ key: 'model' as const, requested: 'sonnet', effective: 'sonnet' }],
            };
            const composition = agentId === 'codex'
                ? await createCodexComposition(sessionId)
                : await createClaudeComposition({
                    sessionId,
                    publishSemanticSessionEvent: () => hostServices.transcripts.publishSessionEvent(semanticEvent),
                });
            const runtime = createNativeAgentSessionOperations(composition.session, sessionId);
            const bridge = createKeyedStreamedTranscriptBridge({
                provider: composition.agentId,
                createSessionForStream: () => transcriptSession,
                initialCheckpointDelayMs: null,
                checkpointIntervalMs: null,
                liveSnapshotIntervalMs: null,
            });
            let projection = Promise.resolve();
            const projectedKinds = new Set<string>([
                'message-delta',
                'tool-call',
                'tool-result',
                'turn-complete',
            ]);
            const unsubscribe = runtime.subscribeRuntimeEvents((event) => {
                if (!('kind' in event) || !projectedKinds.has(event.kind)) return;
                projection = projection.then(async () => {
                    const result = await projectRuntimeTranscriptEvent({
                        session: transcriptSession,
                        provider: composition.agentId,
                        runtimeMessageDeltaBridge: bridge,
                        event,
                    });
                    if (!result.projected) {
                        throw new Error(`Runtime transcript event '${event.kind}' was not projected`);
                    }
                });
            });

            try {
                await outbox.awaitReady();
                await outbox.setSessionSyncPendingInputServerContract({
                    mode: 'session_sync_v2_pending_input_v1',
                    runtimeActivity: 'v2',
                    pendingInput: 'v1',
                    publisherAuthority: 'indeterminate',
                    sessionConnectionEpoch: 1,
                    socket: {},
                    transcriptTransport: { mode: 'session_transcript_observation_v1' },
                });
                await runtime.sendTurnPrompt(`run ${agentId} composition`, {
                    localId: `${agentId}-input-1`,
                    turnId: `turn-${agentId}`,
                });
                await runtime.waitForTurnCompletion({ timeoutMs: 1_000 });
                await projection;
                if (composition.publishSemanticSessionEvent) {
                    await expect(composition.publishSemanticSessionEvent()).resolves.toEqual({
                        status: 'custodied',
                    });
                }

                const retained = await loadSessionClientDurableMutationOutbox(sessionId);
                expect(retained).toHaveLength(agentId === 'claude' ? 4 : 3);
                const retainedJson = JSON.stringify(retained);
                expect(retainedJson).toContain(composition.assistantText);
                expect(retainedJson).toContain(`${agentId} tool output`);
                expect(retainedJson).toContain('tool-call');
                expect(retainedJson).toContain('tool-result');
                if (agentId === 'claude') {
                    expect(retainedJson).toContain('runtime-config-outcome');
                }
                expect(socket.emitWithAck).not.toHaveBeenCalled();

                socket.connected = true;
                await outbox.flush('connect');

                const afterLostAck = await loadSessionClientDurableMutationOutbox(sessionId);
                expect(afterLostAck).not.toHaveLength(0);
                expect(afterLostAck).toContainEqual(expect.objectContaining({
                    mutationId: `transcript:${sessionId}:${deliveryLocalIds[0]}`,
                    attempts: 1,
                    lastAttempt: expect.objectContaining({ reason: 'delivery_not_confirmed' }),
                }));

                await outbox.flush('connect');

                expect(await loadSessionClientDurableMutationOutbox(sessionId)).toEqual([]);
                expect(new Set(deliveryLocalIds).size).toBe(retained.length);
                expect(deliveryLocalIds).toHaveLength(retained.length + 1);
                expect(deliveryLocalIds.filter((localId) => localId === deliveryLocalIds[0])).toHaveLength(2);
            } finally {
                unsubscribe();
                await runtime.resetOrDisposeRuntime('session_closed').catch(() => undefined);
                socket.connected = true;
                loseNextAck = false;
                await outbox.close();
                restoreEnv('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', originalBaseRetryMs);
                restoreEnv('HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS', originalMaxRetryMs);
                restoreEnv('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', originalJitterMs);
                restoreEnv('HAPPIER_SESSION_MUTATION_OUTBOX_DELIVERY_CONCURRENCY', originalDeliveryConcurrency);
            }
        },
        120_000,
    );
});
