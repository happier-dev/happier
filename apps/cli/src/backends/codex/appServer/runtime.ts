import { randomUUID } from 'node:crypto';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { configuration } from '@/configuration';
import {
    resolveSessionRollbackPlan,
    type CompletedConversationTurn,
    type SessionRollbackRpcParams,
    type SessionRollbackRpcResult,
} from '@happier-dev/protocol';
import { TurnChangeSetCollector } from '@/agent/tools/diff/turnChangeSetCollector';
import { emitCanonicalTurnDiffTool } from '@/agent/runtime/emitCanonicalTurnDiffTool';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';
import { publishCodexSessionIdMetadata } from '../utils/codexSessionIdMetadata';
import { resolveApprovalChoiceLabel } from '../runtime/codexRequestUserInputBridge';
import {
    buildCodexRequestUserInputAnswers,
    looksLikeCodexApprovalRequestUserInput,
    normalizeCodexRequestUserInputQuestionsToAskUserQuestionInput,
} from '../runtime/codexRequestUserInputQuestions';
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
import { createCodexSyntheticSubagentTracker } from '../collaboration/createCodexSyntheticSubagentTracker';
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

type StreamUpdateContext = Readonly<{
    sidechainId: string | null;
    streamScopeId: string;
}>;

type PendingRawAssistantFinal = Readonly<{
    text: string;
    sidechainId: string | null;
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

function buildThreadServiceTierParams(
    currentServiceTier: string | null,
    hasServiceTierOverride: boolean,
): { serviceTier?: 'fast' | null } {
    if (!hasServiceTierOverride) {
        return {};
    }
    return currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null };
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
    const runtimeEnv = params.processEnv ?? process.env;
    const lastPublishedThreadId: { value: string | null } = { value: null };
    let threadId: string | null = null;
    let turnInFlight = false;
    let thinking = false;
    let pendingTurn: PendingTurn | null = null;
    let latestPendingTurnId: string | null = null;
    let clientPromise: Promise<DisposableCodexAppServerClient> | null = null;
    let currentModeId: string | null = null;
    let currentModelId: string | null = null;
    let currentReasoningEffort: string | null = null;
    let currentServiceTier: string | null = null;
    let hasServiceTierOverride = false;
    let pendingTurnStartSeqInclusive: number | null = null;
    const completedTurnSeqRanges: CompletedTurnSeqRange[] = [];
    let pendingTurnFinalizationTimer: ReturnType<typeof setTimeout> | null = null;
    let scheduledPendingTurnFlushReason: 'turn-end' | 'abort' | null = null;
    const streamEventBridge = createCodexAppServerStreamEventBridge();
    const turnChangeCollector = new TurnChangeSetCollector({
        provider: 'codex',
        snapshotUnifiedDiff: true,
    });
    const itemTranscriptBridge = createKeyedStreamedTranscriptBridge<{
        streamKey: string;
        sidechainId: string | null;
    }>({
        provider: 'codex',
        createSessionForStream: () => params.session,
    });
    const assistantTextByItemId = new Map<string, string>();
    const reasoningTextByItemId = new Map<string, string>();
    const latestAssistantItemIdByStreamScope = new Map<string, string>();
    const normalizedAssistantFinalSeenByStreamScope = new Set<string>();
    const rawAssistantFinalByStreamScope = new Map<string, PendingRawAssistantFinal>();
    const syntheticSubagentThreadIds = new Set<string>();
    const syntheticSubagentTracker = createCodexSyntheticSubagentTracker({
        session: params.session,
    });
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

    // `turn/steer` and `turn/interrupt` require a turn id, but we may not have observed it yet
    // when the user acts immediately after sending a message (the id can arrive via the
    // `turn/start` response or the `turn/started` notification). Keep this bounded, but large
    // enough to survive transient event-loop delays in real runs.
    const turnIdWaitTimeoutMs = 1_000;
    const turnIdWaitPollMs = 20;
    const waitForActiveTurnId = async (): Promise<string | null> => {
        let turnId = pendingTurn?.turnId ?? latestPendingTurnId;
        if (turnId) return turnId;
        const waitStartedAt = Date.now();
        while (!turnId && Date.now() - waitStartedAt < turnIdWaitTimeoutMs) {
            await delay(turnIdWaitPollMs);
            turnId = pendingTurn?.turnId ?? latestPendingTurnId;
        }
        return turnId ?? null;
    };

    const publishThreadId = (): void => {
        publishCodexSessionIdMetadata({
            session: params.session,
            getCodexThreadId: () => threadId,
            backendMode: 'appServer',
            transcriptStorage: runtimeEnv.HAPPIER_TRANSCRIPT_STORAGE === 'direct' ? 'direct' : 'persisted',
            codexHome: runtimeEnv.CODEX_HOME ?? null,
            activeServerDir: params.activeServerDir ?? null,
            lastPublished: lastPublishedThreadId,
        });
    };

    const publishSessionControls = async (client: DisposableCodexAppServerClient): Promise<void> => {
        const environmentAuth = readCodexEnvironmentAuthState(runtimeEnv);
        await publishCodexAppServerSessionControlsMetadata({
            client,
            session: params.session,
            provider: 'codex',
            authMethod: environmentAuth.method,
            currentModeId,
            currentModelId,
            currentReasoningEffort,
            currentServiceTier,
        }).catch(() => undefined);
    };

    const runBridgeWork = async <T>(work: () => Promise<T>): Promise<T> => {
        const next = bridgeWork.then(work);
        bridgeWork = next.then(() => undefined, () => undefined);
        return await next;
    };

    const appendStreamDelta = (itemKey: string, text: string, values: Map<string, string>, append: (deltaText: string) => void): void => {
        if (!text) return;
        append(text);
        values.set(itemKey, `${values.get(itemKey) ?? ''}${text}`);
    };

    const appendStreamFinal = (
        itemKey: string,
        text: string,
        values: Map<string, string>,
        append: (deltaText: string) => void,
        override: (finalText: string) => void,
    ): void => {
        const accumulated = values.get(itemKey) ?? '';
        values.delete(itemKey);
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

    const commitRawAssistantFinal = (streamScopeId: string, pending: PendingRawAssistantFinal): void => {
        const itemId = latestAssistantItemIdByStreamScope.get(streamScopeId) ?? 'raw-response-item';
        appendStreamFinal(
            buildItemStateKey(streamScopeId, itemId),
            pending.text,
            assistantTextByItemId,
            (deltaText) => {
                itemTranscriptBridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildItemStreamKey(streamScopeId, 'assistant', itemId),
                    sidechainId: pending.sidechainId,
                });
            },
            (finalText) => {
                itemTranscriptBridge.overrideAssistantText({
                    text: finalText,
                    streamKey: buildItemStreamKey(streamScopeId, 'assistant', itemId),
                    sidechainId: pending.sidechainId,
                });
            },
        );
    };

    const commitPendingRawAssistantFinals = (): void => {
        for (const [streamScopeId, pendingRaw] of rawAssistantFinalByStreamScope.entries()) {
            if (!normalizedAssistantFinalSeenByStreamScope.has(streamScopeId)) {
                commitRawAssistantFinal(streamScopeId, pendingRaw);
            }
            rawAssistantFinalByStreamScope.delete(streamScopeId);
        }
    };

    const buildItemStateKey = (scopeId: string, itemId: string): string => `${scopeId}:${itemId}`;
    const buildItemStreamKey = (scopeId: string, kind: 'assistant' | 'reasoning', itemId: string): string =>
        `${scopeId}:${kind}:${itemId}`;

    const ensureSyntheticSubagentThread = async (threadId: string): Promise<string> => {
        if (syntheticSubagentThreadIds.has(threadId)) return threadId;
        await itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
        syntheticSubagentTracker.ensureStarted({ threadId });
        syntheticSubagentThreadIds.add(threadId);
        return threadId;
    };

    const finalizeSyntheticSubagentThread = async (threadId: string, status: 'completed' | 'interrupted'): Promise<void> => {
        await ensureSyntheticSubagentThread(threadId);
        await itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
        syntheticSubagentTracker.finalize({ threadId, status });
    };

    const applyStreamUpdate = async (update: CodexAppServerStreamUpdate, context: StreamUpdateContext): Promise<void> => {
        if (update.type === 'assistant-text-delta') {
            latestAssistantItemIdByStreamScope.set(context.streamScopeId, update.itemId);
            appendStreamDelta(buildItemStateKey(context.streamScopeId, update.itemId), update.text, assistantTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'assistant', update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'assistant-text-final') {
            latestAssistantItemIdByStreamScope.set(context.streamScopeId, update.itemId);
            normalizedAssistantFinalSeenByStreamScope.add(context.streamScopeId);
            rawAssistantFinalByStreamScope.delete(context.streamScopeId);
            appendStreamFinal(buildItemStateKey(context.streamScopeId, update.itemId), update.text, assistantTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendAssistantDelta({
                    deltaText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'assistant', update.itemId),
                    sidechainId: context.sidechainId,
                });
            }, (finalText) => {
                itemTranscriptBridge.overrideAssistantText({
                    text: finalText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'assistant', update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'assistant-raw-final') {
            if (normalizedAssistantFinalSeenByStreamScope.has(context.streamScopeId)) {
                return;
            }
            rawAssistantFinalByStreamScope.set(context.streamScopeId, {
                text: update.text,
                sidechainId: context.sidechainId,
            });
            return;
        }

        if (update.type === 'reasoning-delta') {
            appendStreamDelta(buildItemStateKey(context.streamScopeId, update.itemId), update.text, reasoningTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendThinkingDelta({
                    deltaText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'reasoning-final') {
            appendStreamFinal(buildItemStateKey(context.streamScopeId, update.itemId), update.text, reasoningTextByItemId, (deltaText) => {
                itemTranscriptBridge.appendThinkingDelta({
                    deltaText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                    sidechainId: context.sidechainId,
                });
            }, (finalText) => {
                itemTranscriptBridge.overrideThinkingText({
                    text: finalText,
                    streamKey: buildItemStreamKey(context.streamScopeId, 'reasoning', update.itemId),
                    sidechainId: context.sidechainId,
                });
            });
            return;
        }

        if (update.type === 'turn-diff-updated') {
            if (context.sidechainId) return;
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
            await itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
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
            if (context.sidechainId) {
                params.session.sendAgentMessage('codex', {
                    type: 'tool-call',
                    name: update.name,
                    callId: update.callId,
                    input: update.input,
                    id: randomUUID(),
                    sidechainId: context.sidechainId,
                });
            } else {
                params.session.sendCodexMessage({
                    type: 'tool-call',
                    name: update.name,
                    callId: update.callId,
                    input: update.input,
                    id: randomUUID(),
                });
            }
            return;
        }

        if (update.type === 'tool-result') {
            if (context.sidechainId) {
                params.session.sendAgentMessage('codex', {
                    type: 'tool-result',
                    callId: update.callId,
                    output: update.output,
                    id: randomUUID(),
                    sidechainId: context.sidechainId,
                });
            } else {
                params.session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: update.callId,
                    output: update.output,
                    id: randomUUID(),
                });
            }
        }
    };

    const flushStreamState = async (reason: 'turn-end' | 'abort'): Promise<void> => {
        assistantTextByItemId.clear();
        reasoningTextByItemId.clear();
        latestAssistantItemIdByStreamScope.clear();
        normalizedAssistantFinalSeenByStreamScope.clear();
        rawAssistantFinalByStreamScope.clear();
        await itemTranscriptBridge.flushAll({
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

    const buildUserInputResponse = (
        update: Extract<CodexAppServerStreamUpdate, { type: 'user-input-request' }>,
        result: PermissionResult,
        options?: Readonly<{ allowDecisionFallback?: boolean }>,
    ): Readonly<Record<string, unknown>> => {
        const answers = buildCodexRequestUserInputAnswers({
            questions: update.questions,
            answersByKey: result.answers ?? {},
        });

        if (options?.allowDecisionFallback === true && Object.keys(answers).length === 0) {
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
            const treatAsApproval = looksLikeCodexApprovalRequestUserInput({
                toolName: update.toolName,
                questions: update.questions,
            });
            logger.debug('[codex-app-server] requestUserInput received', {
                callId: update.callId,
                toolName: update.toolName,
                treatAsApproval,
                questionSummaries: update.questions.map((question) => {
                    if (!question || typeof question !== 'object' || Array.isArray(question)) return null;
                    const record = question as Record<string, unknown>;
                    const options = Array.isArray(record.options)
                        ? record.options
                            .map((option) => {
                                if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
                                const optionRecord = option as Record<string, unknown>;
                                return typeof optionRecord.label === 'string' ? optionRecord.label : null;
                            })
                            .filter((label): label is string => Boolean(label))
                        : [];
                    return {
                        id: typeof record.id === 'string' ? record.id : null,
                        header: typeof record.header === 'string' ? record.header : null,
                        question: typeof record.question === 'string' ? record.question : null,
                        options,
                    };
                }).filter(Boolean),
            });
            const toolName = treatAsApproval ? update.toolName : 'AskUserQuestion';
            const toolInput = treatAsApproval
                ? {
                    ...(update.input && typeof update.input === 'object' && !Array.isArray(update.input)
                        ? update.input as Record<string, unknown>
                            : {}),
                        requestUserInput: {
                            questions: update.questions,
                        },
                    }
                    : normalizeCodexRequestUserInputQuestionsToAskUserQuestionInput(update.questions);
            const result = params.permissionHandler
                    ? await params.permissionHandler.handleToolCall(update.callId, toolName, toolInput)
                    : { decision: 'abort' as const };
            logger.debug('[codex-app-server] requestUserInput resolved', {
                callId: update.callId,
                toolName,
                decision: result.decision,
                answerKeys: result.answers ? Object.keys(result.answers) : [],
            });
            return buildUserInputResponse(update, result, { allowDecisionFallback: treatAsApproval });
        }
        }

        return null;
    };

    const finishPendingTurn = async (options?: Readonly<{
        error?: Error;
        flushReason?: 'turn-end' | 'abort';
        insideBridgeWork?: boolean;
    }>): Promise<void> => {
        if (pendingTurnFinalizationTimer) {
            clearTimeout(pendingTurnFinalizationTimer);
            pendingTurnFinalizationTimer = null;
        }
        scheduledPendingTurnFlushReason = null;
        const activeTurn = pendingTurn;
        const completedTurnStartSeqInclusive = pendingTurnStartSeqInclusive;
        pendingTurn = null;
        pendingTurnStartSeqInclusive = null;
        turnInFlight = false;
        setThinking(false);
        if (options?.flushReason) {
            if (options.insideBridgeWork === true) {
                if (options.flushReason === 'turn-end') {
                    commitPendingRawAssistantFinals();
                }
                await flushStreamState(options.flushReason);
            } else {
                await runBridgeWork(async () => {
                    if (options.flushReason === 'turn-end') {
                        commitPendingRawAssistantFinals();
                    }
                    await flushStreamState(options.flushReason!);
                });
            }
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
            const completedTurnUserMessageSeq = readLastObservedUserMessageSeq(params.session);
            const completedTurnSeqRange = captureCompletedTurnSeqRange({
                userMessageSeq: completedTurnUserMessageSeq > 0 ? completedTurnUserMessageSeq : completedTurnStartSeqInclusive,
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

    const schedulePendingTurnFinalization = (flushReason: 'turn-end' | 'abort'): void => {
        if (!pendingTurn) return;
        scheduledPendingTurnFlushReason =
            scheduledPendingTurnFlushReason === 'abort' || flushReason === 'abort'
                ? 'abort'
                : 'turn-end';
        if (pendingTurnFinalizationTimer) {
            return;
        }
        const settleMs = configuration.codexAppServerTurnCompletionSettleMs;
        pendingTurnFinalizationTimer = setTimeout(() => {
            pendingTurnFinalizationTimer = null;
            const nextFlushReason = scheduledPendingTurnFlushReason ?? flushReason;
            scheduledPendingTurnFlushReason = null;
            void runBridgeWork(async () => {
                if (!pendingTurn) return;
                await finishPendingTurn({
                    flushReason: nextFlushReason,
                    insideBridgeWork: true,
                });
            });
        }, settleMs);
        pendingTurnFinalizationTimer.unref?.();
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

    const resolveStreamUpdateContext = (notificationParams: unknown): StreamUpdateContext | null => {
        const activeTurn = pendingTurn;
        if (!activeTurn) return null;
        const notificationThreadId = readThreadId(notificationParams);
        if (notificationThreadId && notificationThreadId !== activeTurn.threadId) {
            return {
                sidechainId: notificationThreadId,
                streamScopeId: notificationThreadId,
            };
        }
        return {
            sidechainId: null,
            streamScopeId: activeTurn.threadId,
        };
    };

    const registerActiveTurnStreamNotificationHandler = (
        client: DisposableCodexAppServerClient,
        method: string,
    ): void => {
        client.registerNotificationHandler(method, (notificationParams) => {
            return runBridgeWork(async () => {
                const context = resolveStreamUpdateContext(notificationParams);
                if (!context) return;
                if (context.sidechainId) {
                    await ensureSyntheticSubagentThread(context.sidechainId);
                } else if (!notificationMatchesPendingTurn(notificationParams)) {
                    return;
                }
                for (const update of streamEventBridge.onNotification({ method, params: notificationParams })) {
                    await applyStreamUpdate(update, context);
                }
            });
        });
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
                    registerActiveTurnStreamNotificationHandler(client, 'item/agentMessage/delta');
                    registerActiveTurnStreamNotificationHandler(client, 'turn/diff/updated');
                    registerActiveTurnStreamNotificationHandler(client, 'item/reasoning/summaryTextDelta');
                    registerActiveTurnStreamNotificationHandler(client, 'item/reasoning/textDelta');
                    registerActiveTurnStreamNotificationHandler(client, 'item/started');
                    registerActiveTurnStreamNotificationHandler(client, 'item/completed');
                    registerActiveTurnStreamNotificationHandler(client, 'rawResponseItem/completed');
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
                            await runBridgeWork(async () => {
                                if (notificationMatchesPendingTurn(notificationParams)) {
                                    schedulePendingTurnFinalization(
                                        method === 'turn/completed' ? 'turn-end' : 'abort',
                                    );
                                    return;
                                }
                                const activeTurn = pendingTurn;
                                const childThreadId = readThreadId(notificationParams);
                                if (!activeTurn || !childThreadId || childThreadId === activeTurn.threadId) {
                                    return;
                                }
                                await finalizeSyntheticSubagentThread(
                                    childThreadId,
                                    method === 'turn/completed' ? 'completed' : 'interrupted',
                                );
                            });
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
                    ...(currentModelId ? { model: currentModelId } : {}),
                    ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
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
                    ...(currentModelId ? { model: currentModelId } : {}),
                    ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
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
                ...(currentModelId ? { model: currentModelId } : {}),
                ...buildThreadServiceTierParams(currentServiceTier, hasServiceTierOverride),
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
        const serviceTierFromResponse = readServiceTier(startOrLoadResponse);
        // Codex app-server may omit `serviceTier` from thread/start responses even when an explicit
        // override was sent. Do not clear an explicit override based on a missing/empty response.
        if (serviceTierFromResponse !== null) {
            currentServiceTier = serviceTierFromResponse;
        } else if (!hasServiceTierOverride) {
            currentServiceTier = null;
        }
        await finishPendingTurn({ flushReason: 'abort' });
        publishThreadId();
        await publishSessionControls(client);
    };

    return {
        getSessionId: () => threadId,
        // Codex app-server exposes `turn/steer`, which appends user input to the active in-flight
        // turn without interrupting it. This may not affect a currently-running tool until that
        // tool finishes, but it should still be handled within the same turn.
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
            const interruptTurnId = (activeTurn.turnId ?? latestPendingTurnId) ?? (await waitForActiveTurnId());
            if (!interruptTurnId) {
                // If we can't resolve the turn id, fall back to tearing down the runtime; this will
                // abort the active work without relying on turn-scoped cancellation.
                await disposeClient();
                return;
            }
            await client.request('turn/interrupt', { threadId: activeTurn.threadId, turnId: interruptTurnId });
            await finishPendingTurn({ flushReason: 'abort' });
        },
        reset: async () => {
            threadId = null;
            currentModeId = null;
            currentModelId = null;
            currentReasoningEffort = null;
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
                modesResponse: await client.request('collaborationMode/list', {}),
                modelsResponse: await client.request('model/list', {}),
                modeId: nextModeId,
                currentModelId,
                currentReasoningEffort,
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
            // Apply model changes per-turn via `turn/start` (we always pass `model` there).
            // Avoid `thread/resume` here: it can be expensive (returns thread content) and failures
            // are treated as best-effort by metadata synchronizers.
            await publishSessionControls(client);
        },
        setSessionConfigOption: async (key: string, value: unknown) => {
            if (key === 'reasoning_effort') {
                const nextReasoningEffort = trimStringValue(value);
                if (!nextReasoningEffort) {
                    throw new Error('Codex app-server reasoning_effort requires a non-empty value');
                }
                currentReasoningEffort = nextReasoningEffort;
                const client = await ensureClient();
                await publishSessionControls(client);
                return;
            }
            if (key === 'service_tier' || key === 'speed') {
                const nextServiceTier = trimStringValue(value);
                if (nextServiceTier !== 'fast' && nextServiceTier !== 'standard') {
                    throw new Error(`Unsupported Codex app-server Speed value: ${String(value)}`);
                }
                currentServiceTier = nextServiceTier;
                hasServiceTierOverride = true;
                const client = await ensureClient();
                // Apply Speed changes per-turn via `turn/start` (we pass `serviceTier` there).
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
            const expectedTurnId = (activeTurn.turnId ?? latestPendingTurnId) ?? (await waitForActiveTurnId());
            if (!expectedTurnId) {
                throw new Error('Codex app-server steerPrompt requires an active turn id');
            }

            const payload = {
                threadId: activeTurn.threadId,
                input: [{ type: 'text', text: prompt }],
            };
            try {
                await client.request('turn/steer', {
                    ...payload,
                    expectedTurnId,
                });
            } catch (error) {
                // Backward compatibility: older experimental app-server builds used `turnId` instead
                // of `expectedTurnId`.
                const message = error instanceof Error ? error.message : String(error ?? '');
                const normalized = message.toLowerCase();
                const looksLikeParamMismatch =
                    (normalized.includes('expectedturnid') || normalized.includes('expected turn') || normalized.includes('turnid'))
                    && (normalized.includes('require') || normalized.includes('missing') || normalized.includes('unknown') || normalized.includes('invalid'));
                if (!looksLikeParamMismatch) {
                    throw error;
                }
                await client.request('turn/steer', {
                    ...payload,
                    turnId: expectedTurnId,
                });
            }
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
                        modesResponse: await client.request('collaborationMode/list', {}),
                        modelsResponse: await client.request('model/list', {}),
                        modeId: currentModeId,
                        currentModelId,
                        currentReasoningEffort,
                    })?.payload
                    : null;
                const response = await client.request('turn/start', {
                    threadId: activeThreadId,
                    input: [{ type: 'text', text: prompt }],
                    ...(currentModelId ? { model: currentModelId } : {}),
                    ...(currentReasoningEffort ? { effort: currentReasoningEffort } : {}),
                    ...(hasServiceTierOverride ? (currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null }) : {}),
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
