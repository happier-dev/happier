import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import {
    resolveSessionRollbackPlan,
    type CompletedConversationTurn,
    type SessionRollbackRpcParams,
    type SessionRollbackRpcResult,
} from '@happier-dev/protocol';
import { TurnChangeSetCollector } from '@/agent/tools/diff/turnChangeSetCollector';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { publishCodexSessionIdMetadata } from '../utils/codexSessionIdMetadata';
import { resolveApprovalChoiceLabel } from '../runtime/codexRequestUserInputBridge';
import { resolveCodexAppServerPolicyForPermissionMode } from '../utils/permissionModePolicy';
import { readCodexEnvironmentAuthState } from '../cli/auth/readCodexEnvironmentAuthState';

import {
    createCodexAppServerClient,
    type DisposableCodexAppServerClient,
} from './client/createCodexAppServerClient';
import {
    createCodexAppServerStreamEventBridge,
    type CodexAppServerStreamUpdate,
} from './streamEventBridge';
import {
    publishCodexAppServerSessionControlsMetadata,
    resolveCodexAppServerCollaborationModeSelection,
} from './sessionControlsMetadata';
import {
    captureCompletedTurnSeqRange,
    publishRollbackRangeMetadata,
    publishLatestTurnRollbackRangeMetadata,
    type CompletedTurnSeqRange,
} from './rollbackMetadata';

type CodexAppServerStartOrLoadOptions = Readonly<{
    resumeId?: string | null;
    existingSessionId?: string | null;
    importHistory?: boolean;
}>;

type CodexAppServerThreadResponse = Readonly<{
    threadId?: unknown;
    id?: unknown;
    thread?: Readonly<{ id?: unknown; threadId?: unknown }> | null;
}>;

type CodexAppServerTurnResponse = Readonly<{
    turnId?: unknown;
    id?: unknown;
    turn?: Readonly<{ id?: unknown; turnId?: unknown }> | null;
}>;

type PendingTurn = Readonly<{
    threadId: string;
    turnId: string | null;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
}>;

type PermissionResult = Readonly<{
    decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: Readonly<{ command: string[] }>;
    answers?: Record<string, string>;
}>;

type PermissionHandlerSubset = Readonly<{
    handleToolCall: (toolCallId: string, toolName: string, input: unknown) => Promise<PermissionResult>;
}>;

type RuntimeSession = ApiSessionClient;

function readLastObservedMessageSeq(session: RuntimeSession): number {
    const raw = typeof session.getLastObservedMessageSeq === 'function'
        ? session.getLastObservedMessageSeq()
        : 0;
    return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

function readLastObservedUserMessageSeq(session: RuntimeSession): number {
    const raw = typeof (session as RuntimeSession & { getLastObservedUserMessageSeq?: () => number }).getLastObservedUserMessageSeq === 'function'
        ? (session as RuntimeSession & { getLastObservedUserMessageSeq: () => number }).getLastObservedUserMessageSeq()
        : readLastObservedMessageSeq(session);
    return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

function readThreadId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const response = value as CodexAppServerThreadResponse;
    const candidates = [response.threadId, response.id, response.thread?.threadId, response.thread?.id];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}

function readTurnId(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const response = value as CodexAppServerTurnResponse;
    const candidates = [response.turnId, response.id, response.turn?.turnId, response.turn?.id];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
            return candidate.trim();
        }
    }
    return null;
}

function trimSessionId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function trimStringValue(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRollbackUnsupportedErrorMessage(error: unknown): string | null {
    if (!(error instanceof Error)) return null;
    const message = error.message.trim();
    if (message.length === 0) return null;
    const normalized = message.toLowerCase();
    if (normalized.includes('method not found') || normalized.includes('invalid params')) {
        return message;
    }
    return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function readModelId(value: unknown): string | null {
    const record = readRecord(value);
    return record ? trimStringValue(record.model) : null;
}

function readServiceTier(value: unknown): string | null {
    const record = readRecord(value);
    return record ? trimStringValue(record.serviceTier) ?? trimStringValue(record.service_tier) : null;
}

function createPendingTurn(threadId: string): PendingTurn {
    let resolveTurn!: () => void;
    let rejectTurn!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
    });
    return {
        threadId,
        turnId: null,
        promise,
        resolve: resolveTurn,
        reject: rejectTurn,
    };
}

export function createCodexAppServerRuntime(params: Readonly<{
    directory: string;
    activeServerDir?: string | null;
    processEnv?: NodeJS.ProcessEnv;
    configOverrides?: ReadonlyArray<string>;
    session: RuntimeSession;
    onThinkingChange: (thinking: boolean) => void;
    permissionHandler?: PermissionHandlerSubset | null;
    getPermissionMode?: (() => PermissionMode) | null;
    permissionMode?: PermissionMode;
}>): Readonly<{
    getSessionId: () => string | null;
    supportsInFlightSteer: () => boolean;
    isTurnInFlight: () => boolean;
    beginTurn: () => void;
    cancel: () => Promise<void>;
    reset: () => Promise<void>;
    startOrLoad: (options: CodexAppServerStartOrLoadOptions) => Promise<void>;
    setSessionMode: (_mode: string) => Promise<void>;
    setSessionModel: (_model: string) => Promise<void>;
    setSessionConfigOption: (_key: string, _value: unknown) => Promise<void>;
    steerPrompt: (_prompt: string) => Promise<void>;
    sendPrompt: (_prompt: string) => Promise<void>;
    flushTurn: () => Promise<void>;
    rollbackConversation: (request: SessionRollbackRpcParams) => Promise<SessionRollbackRpcResult>;
}> {
    const lastPublishedThreadId: { value: string | null } = { value: null };
    let threadId: string | null = null;
    let turnInFlight = false;
    let thinking = false;
    let pendingTurn: PendingTurn | null = null;
    let latestPendingTurnId: string | null = null;
    let clientPromise: Promise<DisposableCodexAppServerClient> | null = null;
    let currentModeId: string | null = null;
    let currentModelId: string | null = null;
    let currentServiceTier: string | null = null;
    let pendingTurnStartSeqInclusive: number | null = null;
    let pendingTurnUserMessageSeq: number | null = null;
    const completedTurnSeqRanges: CompletedTurnSeqRange[] = [];
    const streamEventBridge = createCodexAppServerStreamEventBridge();
    const turnChangeCollector = new TurnChangeSetCollector({
        provider: 'codex',
        snapshotUnifiedDiff: true,
    });
    const streamedTranscriptWriter = createStreamedTranscriptWriter({
        provider: 'codex',
        session: params.session,
    });
    const assistantTextByItemId = new Map<string, string>();
    const reasoningTextByItemId = new Map<string, string>();
    let bridgeWork = Promise.resolve();

    const getCurrentPermissionMode = (): PermissionMode => params.getPermissionMode?.() ?? params.permissionMode ?? 'default';

    const resolveCurrentPolicy = () => resolveCodexAppServerPolicyForPermissionMode(getCurrentPermissionMode(), {
        directory: params.directory,
    });

    const setThinking = (nextThinking: boolean): void => {
        if (thinking === nextThinking) return;
        thinking = nextThinking;
        params.onThinkingChange(nextThinking);
    };

    const publishThreadId = (): void => {
        publishCodexSessionIdMetadata({
            session: params.session,
            getCodexThreadId: () => threadId,
            backendMode: 'appServer',
            transcriptStorage: process.env.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
            codexHome: process.env.CODEX_HOME ?? null,
            activeServerDir: params.activeServerDir ?? null,
            lastPublished: lastPublishedThreadId,
        });
    };

    const publishSessionControls = async (client: DisposableCodexAppServerClient): Promise<void> => {
        const environmentAuth = readCodexEnvironmentAuthState();
        await publishCodexAppServerSessionControlsMetadata({
            client,
            session: params.session,
            provider: 'codex',
            authMethod: environmentAuth.method,
            currentModeId,
            currentModelId,
            currentServiceTier,
        }).catch(() => undefined);
    };

    const runBridgeWork = async <T>(work: () => Promise<T>): Promise<T> => {
        const next = bridgeWork.then(work);
        bridgeWork = next.then(() => undefined, () => undefined);
        return await next;
    };

    const appendStreamDelta = (itemId: string, text: string, values: Map<string, string>, append: (deltaText: string) => void): void => {
        if (!text) return;
        append(text);
        values.set(itemId, `${values.get(itemId) ?? ''}${text}`);
    };

    const appendStreamFinal = (
        itemId: string,
        text: string,
        values: Map<string, string>,
        append: (deltaText: string) => void,
        override: (finalText: string) => void,
    ): void => {
        const accumulated = values.get(itemId) ?? '';
        values.delete(itemId);
        if (!text) return;
        if (!accumulated) {
            append(text);
            return;
        }
        if (text.startsWith(accumulated)) {
            const suffix = text.slice(accumulated.length);
            if (suffix) append(suffix);
            return;
        }
        override(text);
    };

    const applyStreamUpdate = async (update: CodexAppServerStreamUpdate): Promise<void> => {
        if (update.type === 'assistant-text-delta') {
            appendStreamDelta(update.itemId, update.text, assistantTextByItemId, (deltaText) => {
                streamedTranscriptWriter.appendAssistantDelta(deltaText);
            });
            return;
        }

        if (update.type === 'assistant-text-final') {
            appendStreamFinal(update.itemId, update.text, assistantTextByItemId, (deltaText) => {
                streamedTranscriptWriter.appendAssistantDelta(deltaText);
            }, (finalText) => {
                streamedTranscriptWriter.overrideAssistantText(finalText);
            });
            return;
        }

        if (update.type === 'reasoning-delta') {
            appendStreamDelta(update.itemId, update.text, reasoningTextByItemId, (deltaText) => {
                streamedTranscriptWriter.appendThinkingDelta(deltaText);
            });
            return;
        }

        if (update.type === 'reasoning-final') {
            appendStreamFinal(update.itemId, update.text, reasoningTextByItemId, (deltaText) => {
                streamedTranscriptWriter.appendThinkingDelta(deltaText);
            }, (finalText) => {
                streamedTranscriptWriter.overrideThinkingText(finalText);
            });
            return;
        }

        if (update.type === 'turn-diff-updated') {
            const activeTurnId = pendingTurn?.turnId ?? null;
            if (update.turnId && activeTurnId && update.turnId !== activeTurnId) {
                return;
            }
            turnChangeCollector.observeUnifiedDiffSnapshot({
                unifiedDiff: update.unifiedDiff,
                source: 'provider_native',
                confidence: 'exact',
            });
            return;
        }

        if (update.type === 'tool-call') {
            await streamedTranscriptWriter.flushAll({ reason: 'tool-call-boundary' });
            if (update.toolKind === 'file-change') {
                const input = update.input && typeof update.input === 'object' && !Array.isArray(update.input)
                    ? update.input as Record<string, unknown>
                    : null;
                const changes = input?.changes;
                if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
                    turnChangeCollector.observePatchChanges({
                        changes: changes as Record<string, unknown>,
                        source: 'provider_tool',
                        confidence: 'strong',
                    });
                }
            }
            params.session.sendCodexMessage({
                type: 'tool-call',
                name: update.name,
                callId: update.callId,
                input: update.input,
                id: randomUUID(),
            });
            return;
        }

        if (update.type === 'tool-result') {
            params.session.sendCodexMessage({
                type: 'tool-call-result',
                callId: update.callId,
                output: update.output,
                id: randomUUID(),
            });
        }
    };

    const flushStreamState = async (reason: 'turn-end' | 'abort'): Promise<void> => {
        assistantTextByItemId.clear();
        reasoningTextByItemId.clear();
        await streamedTranscriptWriter.flushAll({
            reason,
            ...(reason === 'abort' ? { interruptedReason: 'app-server-turn-interrupted' } : {}),
        });
    };

    const mapApprovalDecision = (
        requestKind: 'command-execution' | 'file-change',
        result: PermissionResult,
    ): Readonly<Record<string, unknown>> => {
        if (requestKind === 'command-execution' && result.decision === 'approved_execpolicy_amendment') {
            const amendment = result.execPolicyAmendment?.command;
            if (Array.isArray(amendment) && amendment.length > 0) {
                return {
                    decision: {
                        acceptWithExecpolicyAmendment: {
                            execpolicy_amendment: amendment,
                        },
                    },
                };
            }
        }

        switch (result.decision) {
            case 'approved_for_session':
                return { decision: 'acceptForSession' };
            case 'approved_execpolicy_amendment':
            case 'approved':
                return { decision: 'accept' };
            case 'abort':
                return { decision: 'cancel' };
            case 'denied':
                return { decision: 'decline' };
        }
    };

    const buildUserInputResponse = (update: Extract<CodexAppServerStreamUpdate, { type: 'user-input-request' }>, result: PermissionResult): Readonly<Record<string, unknown>> => {
        const answers: Record<string, { answers: string[] }> = {};
        for (const question of update.questions) {
            if (!question || typeof question !== 'object' || Array.isArray(question)) continue;
            const questionRecord = question as Record<string, unknown>;
            const questionId = typeof questionRecord.id === 'string' ? questionRecord.id : null;
            if (!questionId) continue;
            const explicit = typeof result.answers?.[questionId] === 'string' ? result.answers[questionId] : null;
            if (explicit && explicit.trim()) {
                answers[questionId] = { answers: [explicit] };
                continue;
            }
        }

        if (Object.keys(answers).length === 0) {
            const pickQuestionWithOptions = update.questions.find((question): question is Record<string, unknown> => {
                if (!question || typeof question !== 'object' || Array.isArray(question)) return false;
                const options = (question as Record<string, unknown>).options;
                return Array.isArray(options) && options.some((option) => option && typeof option === 'object' && !Array.isArray(option));
            }) ?? update.questions.find((question): question is Record<string, unknown> => {
                return Boolean(question) && typeof question === 'object' && !Array.isArray(question);
            });

            const optionLabels = Array.isArray(pickQuestionWithOptions?.options)
                ? pickQuestionWithOptions.options
                    .map((option) => {
                        if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
                        const optionRecord = option as Record<string, unknown>;
                        const label = typeof optionRecord.label === 'string'
                            ? optionRecord.label.trim()
                            : '';
                        return label || null;
                    })
                    .filter((label): label is string => Boolean(label))
                : [];

            const choice = (() => {
                const explicit = resolveApprovalChoiceLabel({
                    decision: result.decision,
                    questions: [pickQuestionWithOptions].filter(Boolean),
                    logger: { debug: () => {} },
                });
                if (explicit) return explicit;
                if (result.decision === 'approved' || result.decision === 'approved_execpolicy_amendment' || result.decision === 'approved_for_session') {
                    return optionLabels.find((label) => /approve|allow/i.test(label)) ?? optionLabels[0] ?? null;
                }
                if (result.decision === 'denied') {
                    return optionLabels.find((label) => /deny|reject|decline/i.test(label)) ?? optionLabels.at(-1) ?? null;
                }
                if (result.decision === 'abort') {
                    return optionLabels.find((label) => /cancel|abort|stop/i.test(label)) ?? optionLabels.at(-1) ?? null;
                }
                return null;
            })();

            const questionId = typeof pickQuestionWithOptions?.id === 'string' ? pickQuestionWithOptions.id : null;
            if (choice && questionId) {
                answers[questionId] = { answers: [choice] };
            }
        }

        return { answers };
    };

    const handleServerRequest = async (method: string, requestParams: unknown): Promise<unknown> => {
        const updates = streamEventBridge.onServerRequest({ method, params: requestParams });
        for (const update of updates) {
            if (update.type === 'approval-request') {
                const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, update.toolName, update.input)
                    : { decision: 'denied' as const };
                return mapApprovalDecision(update.requestKind, result);
            }

            if (update.type === 'user-input-request') {
                const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, update.toolName, {
                        ...(update.input && typeof update.input === 'object' && !Array.isArray(update.input)
                            ? update.input as Record<string, unknown>
                            : {}),
                        requestUserInput: {
                            questions: update.questions,
                        },
                    })
                    : { decision: 'abort' as const };
                return buildUserInputResponse(update, result);
            }
        }

        return null;
    };

    const finishPendingTurn = async (options?: Readonly<{ error?: Error; flushReason?: 'turn-end' | 'abort' }>): Promise<void> => {
        const activeTurn = pendingTurn;
        const completedTurnStartSeqInclusive = pendingTurnStartSeqInclusive;
        const completedTurnUserMessageSeq = pendingTurnUserMessageSeq;
        pendingTurn = null;
        pendingTurnStartSeqInclusive = null;
        pendingTurnUserMessageSeq = null;
        turnInFlight = false;
        setThinking(false);
        if (options?.flushReason) {
            await runBridgeWork(async () => {
                await flushStreamState(options.flushReason!);
            });
        }
        if (options?.flushReason === 'turn-end' && activeTurn) {
            const turnChangeSet = turnChangeCollector.flushTurn({
                sessionId: params.session.sessionId ?? activeTurn.threadId,
                turnId: activeTurn.turnId ?? latestPendingTurnId ?? `codex-app-server-turn-${Date.now()}`,
                seqRange: {
                    startSeqInclusive: completedTurnStartSeqInclusive ?? 0,
                    endSeqInclusive: readLastObservedMessageSeq(params.session),
                },
                status: 'completed',
            });
            if (turnChangeSet) {
                emitCanonicalTurnDiffTool({
                    turnChangeSet,
                    protocol: 'codex',
                    rawToolName: 'CodexDiff',
                    sendToolCall: ({ toolName, input, callId }) => {
                        const resolvedCallId = callId ?? randomUUID();
                        params.session.sendCodexMessage({
                            type: 'tool-call',
                            name: toolName,
                            callId: resolvedCallId,
                            input,
                            id: randomUUID(),
                        });
                        return resolvedCallId;
                    },
                    sendToolResult: ({ callId, output }) => {
                        params.session.sendCodexMessage({
                            type: 'tool-call-result',
                            callId,
                            output,
                            id: randomUUID(),
                        });
                    },
                });
            }
        } else {
            turnChangeCollector.beginTurn();
        }
        latestPendingTurnId = null;
        if (options?.flushReason === 'turn-end' && completedTurnStartSeqInclusive !== null) {
            const completedTurnSeqRange = captureCompletedTurnSeqRange({
                userMessageSeq: completedTurnUserMessageSeq ?? completedTurnStartSeqInclusive,
                startSeqInclusive: completedTurnStartSeqInclusive,
                endSeqInclusive: readLastObservedMessageSeq(params.session),
            });
            if (completedTurnSeqRange) {
                completedTurnSeqRanges.push(completedTurnSeqRange);
            }
        }
        if (!activeTurn) return;
        if (options?.error) {
            activeTurn.reject(options.error);
            return;
        }
        activeTurn.resolve();
    };

    const notificationMatchesPendingTurn = (notificationParams: unknown): boolean => {
        const activeTurn = pendingTurn;
        if (!activeTurn) return false;
        const notificationThreadId = readThreadId(notificationParams);
        if (notificationThreadId && notificationThreadId !== activeTurn.threadId) {
            return false;
        }
        const notificationTurnId = readTurnId(notificationParams);
        return !notificationTurnId || !activeTurn.turnId || notificationTurnId === activeTurn.turnId;
    };

    const ensureClient = async (): Promise<DisposableCodexAppServerClient> => {
        if (!clientPromise) {
            clientPromise = createCodexAppServerClient({
                cwd: params.directory,
                ...(params.processEnv ? { processEnv: params.processEnv } : {}),
                ...(params.configOverrides ? { configOverrides: params.configOverrides } : {}),
            })
                .then((client) => {
                    client.registerNotificationHandler('turn/started', (notificationParams) => {
                        void runBridgeWork(async () => {
                            const activeTurn = pendingTurn;
                            if (!activeTurn || !notificationMatchesPendingTurn(notificationParams)) {
                                return;
                            }
                            const startedTurnId = readTurnId(notificationParams);
                            if (startedTurnId && activeTurn.turnId !== startedTurnId) {
                                pendingTurn = { ...activeTurn, turnId: startedTurnId };
                                latestPendingTurnId = startedTurnId;
                            }
                            const nextThreadId = readThreadId(notificationParams);
                            if (nextThreadId && nextThreadId !== threadId) {
                                threadId = nextThreadId;
                                publishThreadId();
                            }
                            turnInFlight = true;
                            setThinking(true);
                        });
                    });
                    client.registerNotificationHandler('item/agentMessage/delta', (notificationParams) => {
                        return runBridgeWork(async () => {
                            for (const update of streamEventBridge.onNotification({ method: 'item/agentMessage/delta', params: notificationParams })) {
                                await applyStreamUpdate(update);
                            }
                        });
                    });
                    client.registerNotificationHandler('turn/diff/updated', (notificationParams) => {
                        return runBridgeWork(async () => {
                            for (const update of streamEventBridge.onNotification({ method: 'turn/diff/updated', params: notificationParams })) {
                                await applyStreamUpdate(update);
                            }
                        });
                    });
                    client.registerNotificationHandler('item/reasoning/summaryTextDelta', (notificationParams) => {
                        return runBridgeWork(async () => {
                            for (const update of streamEventBridge.onNotification({ method: 'item/reasoning/summaryTextDelta', params: notificationParams })) {
                                await applyStreamUpdate(update);
                            }
                        });
                    });
                    client.registerNotificationHandler('item/reasoning/textDelta', (notificationParams) => {
                        return runBridgeWork(async () => {
                            for (const update of streamEventBridge.onNotification({ method: 'item/reasoning/textDelta', params: notificationParams })) {
                                await applyStreamUpdate(update);
                            }
                        });
                    });
                    client.registerNotificationHandler('item/started', (notificationParams) => {
                        return runBridgeWork(async () => {
                            for (const update of streamEventBridge.onNotification({ method: 'item/started', params: notificationParams })) {
                                await applyStreamUpdate(update);
                            }
                        });
                    });
                    client.registerNotificationHandler('item/completed', (notificationParams) => {
                        return runBridgeWork(async () => {
                            for (const update of streamEventBridge.onNotification({ method: 'item/completed', params: notificationParams })) {
                                await applyStreamUpdate(update);
                            }
                        });
                    });
                    client.registerRequestHandler('item/commandExecution/requestApproval', (requestParams) => {
                        return runBridgeWork(() => handleServerRequest('item/commandExecution/requestApproval', requestParams));
                    });
                    client.registerRequestHandler('item/fileChange/requestApproval', (requestParams) => {
                        return runBridgeWork(() => handleServerRequest('item/fileChange/requestApproval', requestParams));
                    });
                    client.registerRequestHandler('item/tool/requestUserInput', (requestParams) => {
                        return runBridgeWork(() => handleServerRequest('item/tool/requestUserInput', requestParams));
                    });
                    const registerTerminalHandler = (method: string): void => {
                        client.registerNotificationHandler(method, async (notificationParams) => {
                            if (notificationMatchesPendingTurn(notificationParams)) {
                                await finishPendingTurn({
                                    flushReason: method === 'turn/completed' ? 'turn-end' : 'abort',
                                });
                            }
                        });
                    };
                    registerTerminalHandler('turn/completed');
                    registerTerminalHandler('turn/interrupted');
                    registerTerminalHandler('turn/interrupt');
                    return client;
                })
                .catch((error) => {
                    clientPromise = null;
                    throw error;
                });
        }
        return await clientPromise;
    };

    const disposeClient = async (): Promise<void> => {
        const activeClientPromise = clientPromise;
        clientPromise = null;
        if (!activeClientPromise) {
            finishPendingTurn();
            return;
        }
        try {
            const client = await activeClientPromise;
            await client.dispose();
        } finally {
            await finishPendingTurn({ flushReason: 'abort' });
        }
    };

    const startOrLoad = async (options: CodexAppServerStartOrLoadOptions = {}): Promise<void> => {
        const resumeId = trimSessionId(options.resumeId);
        const existingSessionId = trimSessionId(options.existingSessionId);
        const client = await ensureClient();
        let startOrLoadResponse: unknown = null;
        const nextThreadId = await (async (): Promise<string> => {
            if (resumeId) {
                const { approvalPolicy, sandbox } = resolveCurrentPolicy();
                const response = await client.request('thread/resume', {
                    threadId: resumeId,
                    approvalPolicy,
                    sandbox,
                    persistExtendedHistory: true,
                });
                startOrLoadResponse = response;
                return readThreadId(response) ?? resumeId;
            }
            if (existingSessionId) {
                const { approvalPolicy, sandbox } = resolveCurrentPolicy();
                const response = await client.request('thread/resume', {
                    threadId: existingSessionId,
                    approvalPolicy,
                    sandbox,
                    persistExtendedHistory: true,
                });
                startOrLoadResponse = response;
                return readThreadId(response) ?? existingSessionId;
            }
            const { approvalPolicy, sandbox } = resolveCurrentPolicy();
            const response = await client.request('thread/start', {
                cwd: params.directory,
                approvalPolicy,
                sandbox,
                experimentalRawEvents: true,
                persistExtendedHistory: true,
            });
            startOrLoadResponse = response;
            const startedThreadId = readThreadId(response);
            if (!startedThreadId) {
                throw new Error('Codex app-server thread/start returned no thread id');
            }
            return startedThreadId;
        })();
        threadId = nextThreadId;
        currentModelId = readModelId(startOrLoadResponse) ?? currentModelId;
        currentServiceTier = readServiceTier(startOrLoadResponse);
        await finishPendingTurn({ flushReason: 'abort' });
        publishThreadId();
        await publishSessionControls(client);
    };

    return {
        getSessionId: () => threadId,
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => turnInFlight,
        beginTurn: () => {
            turnChangeCollector.beginTurn();
            turnInFlight = true;
            setThinking(true);
        },
        cancel: async () => {
            const activeTurn = pendingTurn;
            if (!activeTurn) {
                turnInFlight = false;
                setThinking(false);
                return;
            }
            const client = await ensureClient();
            let interruptTurnId = activeTurn.turnId ?? latestPendingTurnId;
            if (!interruptTurnId) {
                const waitStartedAt = Date.now();
                while (!interruptTurnId && Date.now() - waitStartedAt < 150) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                    interruptTurnId = pendingTurn?.turnId ?? latestPendingTurnId;
                }
            }
            await client.request('turn/interrupt', {
                threadId: activeTurn.threadId,
                ...(interruptTurnId ? { turnId: interruptTurnId } : {}),
            });
            await finishPendingTurn({ flushReason: 'abort' });
        },
        reset: async () => {
            threadId = null;
            currentModeId = null;
            currentModelId = null;
            currentServiceTier = null;
            await disposeClient();
            turnInFlight = false;
            setThinking(false);
        },
        startOrLoad,
        setSessionMode: async (mode: string) => {
            const client = await ensureClient();
            const nextModeId = trimSessionId(mode);
            if (!nextModeId) {
                throw new Error('Codex app-server setSessionMode requires a non-empty mode id');
            }
            const selection = resolveCodexAppServerCollaborationModeSelection({
                modesResponse: await client.request('collaborationMode/list'),
                modeId: nextModeId,
                currentModelId,
            });
            if (!selection) {
                throw new Error(`Unknown Codex app-server collaboration mode: ${mode}`);
            }
            currentModeId = selection.modeId;
            await publishSessionControls(client);
        },
        setSessionModel: async (model: string) => {
            currentModelId = trimSessionId(model);
            const client = await ensureClient();
            if (threadId && currentModelId) {
                const { approvalPolicy, sandbox } = resolveCurrentPolicy();
                const response = await client.request('thread/resume', {
                    threadId,
                    model: currentModelId,
                    approvalPolicy,
                    sandbox,
                    persistExtendedHistory: true,
                });
                threadId = readThreadId(response) ?? threadId;
                currentModelId = readModelId(response) ?? currentModelId;
                currentServiceTier = readServiceTier(response);
                publishThreadId();
            }
            await publishSessionControls(client);
        },
        setSessionConfigOption: async (key: string, value: unknown) => {
            if (key === 'speed') {
                const nextServiceTier = trimStringValue(value);
                if (nextServiceTier !== 'fast' && nextServiceTier !== 'standard') {
                    throw new Error(`Unsupported Codex app-server Speed value: ${String(value)}`);
                }
                currentServiceTier = nextServiceTier;
                const client = await ensureClient();
                if (threadId) {
                    const { approvalPolicy, sandbox } = resolveCurrentPolicy();
                    const response = await client.request('thread/resume', {
                        threadId,
                        serviceTier: currentServiceTier === 'fast' ? 'fast' : null,
                        approvalPolicy,
                        sandbox,
                        persistExtendedHistory: true,
                    });
                    threadId = readThreadId(response) ?? threadId;
                    currentServiceTier = readServiceTier(response) ?? currentServiceTier;
                    publishThreadId();
                }
                await publishSessionControls(client);
                return;
            }
            throw new Error(`Unsupported Codex app-server config option: ${String(key)}`);
        },
        steerPrompt: async (prompt: string) => {
            const activeTurn = pendingTurn;
            if (!activeTurn) {
                throw new Error('Codex app-server steerPrompt requires an active turn');
            }
            const client = await ensureClient();
            await client.request('turn/steer', {
                threadId: activeTurn.threadId,
                ...(activeTurn.turnId ? { turnId: activeTurn.turnId } : {}),
                input: [{ type: 'text', text: prompt }],
            });
        },
        sendPrompt: async (prompt: string) => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                throw new Error('Codex app-server sendPrompt requires an active thread');
            }
            if (pendingTurn) {
                throw new Error('Codex app-server already has a turn in flight');
            }
            const client = await ensureClient();
            pendingTurnStartSeqInclusive = readLastObservedMessageSeq(params.session);
            pendingTurnUserMessageSeq = readLastObservedUserMessageSeq(params.session);
            turnChangeCollector.beginTurn();
            const activeTurn = createPendingTurn(activeThreadId);
            pendingTurn = activeTurn;
            latestPendingTurnId = null;
            turnInFlight = true;
            setThinking(true);
            try {
                const { approvalPolicy, sandboxPolicy } = resolveCurrentPolicy();
                const collaborationMode = currentModeId
                    ? resolveCodexAppServerCollaborationModeSelection({
                        modesResponse: await client.request('collaborationMode/list'),
                        modeId: currentModeId,
                        currentModelId,
                    })?.payload
                    : null;
                const response = await client.request('turn/start', {
                    threadId: activeThreadId,
                    input: [{ type: 'text', text: prompt }],
                    approvalPolicy,
                    sandboxPolicy,
                    ...(collaborationMode ? { collaborationMode } : {}),
                });
                const startedTurnId = readTurnId(response);
                if (startedTurnId) {
                    pendingTurn = { ...activeTurn, turnId: startedTurnId };
                    latestPendingTurnId = startedTurnId;
                }
                await (pendingTurn ?? activeTurn).promise;
            } catch (error) {
                const failure = error instanceof Error ? error : new Error(String(error));
                await finishPendingTurn({ error: failure, flushReason: 'abort' });
                throw failure;
            }
        },
        flushTurn: async () => {
            await finishPendingTurn({ flushReason: 'turn-end' });
        },
        rollbackConversation: async (request: SessionRollbackRpcParams) => {
            const activeThreadId = threadId;
            if (!activeThreadId) {
                return { ok: false, errorCode: 'thread_not_started', errorMessage: 'Codex app-server rollback requires an active thread' };
            }
            if (pendingTurn) {
                return { ok: false, errorCode: 'turn_in_flight', errorMessage: 'Cannot roll back while a turn is still in flight' };
            }

            const target = request.target;
            const rollbackPlan = resolveSessionRollbackPlan({
                target,
                completedTurns: completedTurnSeqRanges as readonly CompletedConversationTurn[],
            });
            if (!rollbackPlan) {
                return { ok: false, errorCode: 'invalid_parameters', errorMessage: 'Rollback target is not available in the active conversation' };
            }

            const client = await ensureClient();
            try {
                await client.request('thread/rollback', { threadId: activeThreadId, numTurns: rollbackPlan.numTurns });
            } catch (error) {
                const unsupportedMessage = readRollbackUnsupportedErrorMessage(error);
                if (unsupportedMessage) {
                    return { ok: false, errorCode: 'unsupported_action', errorMessage: unsupportedMessage };
                }
                throw error;
            }
            await finishPendingTurn({ flushReason: 'abort' });

            completedTurnSeqRanges.splice(-rollbackPlan.numTurns, rollbackPlan.numTurns);
            const range = captureCompletedTurnSeqRange({
                userMessageSeq: rollbackPlan.targetUserMessageSeq,
                startSeqInclusive: rollbackPlan.range.startSeqInclusive,
                endSeqInclusive: rollbackPlan.range.endSeqInclusive,
            });
            if (range) {
                if (target.type === 'latest_turn') {
                    await publishLatestTurnRollbackRangeMetadata({
                        session: params.session,
                        range,
                    });
                } else {
                    await publishRollbackRangeMetadata({
                        session: params.session,
                        target,
                        range,
                    });
                }
            }
            return { ok: true, target: request.target, threadId: activeThreadId };
        },
    };
}
