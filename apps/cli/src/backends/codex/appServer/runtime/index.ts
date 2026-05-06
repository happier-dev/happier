import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { PermissionMode } from '@/api/types';
import type { StreamedTranscriptWriterSession } from '@/api/session/streamedTranscriptWriter';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    type SessionRollbackRpcParams,
    type SessionRollbackRpcResult,
} from '@happier-dev/protocol';
import { createCodexAppServerRuntimeOperations } from './operations';
import { createCodexAppServerClientLifecycle } from '../createCodexAppServerClientLifecycle';
import {
    createCodexAppServerPendingTurnLifecycle,
    type CodexAppServerPendingTurn,
} from '../createCodexAppServerPendingTurnLifecycle';
import {
    createCodexAppServerRequestHandlers,
    type CodexAppServerPermissionHandler,
} from '../createCodexAppServerRequestHandlers';
import { createCodexAppServerStreamLifecycle } from '../createCodexAppServerStreamLifecycle';
import { createCodexAppServerRuntimeControlState } from '../createCodexAppServerRuntimeControlState';
import { rollbackCodexAppServerConversation } from '../rollbackConversation';
import { type CodexAppServerStartOrLoadOptions } from '../startOrLoadThread';
import { createCodexAppServerStreamEventBridge } from '../streamEventBridge';
import {
    type CompletedTurnSeqRange,
} from '../rollbackMetadata';
import { recordPrimaryTurnInProgress } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';

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

function createPendingTurn(threadId: string): CodexAppServerPendingTurn {
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
    transcriptSession?: StreamedTranscriptWriterSession;
    onThinkingChange: (thinking: boolean) => void;
    permissionHandler?: CodexAppServerPermissionHandler | null;
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
}> & RuntimeTurnOperations {
    const runtimeEnv = params.processEnv ?? process.env;
    const lastPublishedThreadId: { value: string | null } = { value: null };
    let threadId: string | null = null;
    let turnInFlight = false;
    let pendingTurn: CodexAppServerPendingTurn | null = null;
    let latestPendingTurnId: string | null = null;
    let currentModeId: string | null = null;
    let currentModelId: string | null = null;
    let currentReasoningEffort: string | null = null;
    let currentServiceTier: string | null = null;
    let hasServiceTierOverride = false;
    let pendingTurnStartSeqInclusive: number | null = null;
    const completedTurnSeqRanges: CompletedTurnSeqRange[] = [];
    let pendingTurnFinalizationTimer: ReturnType<typeof setTimeout> | null = null;
    let scheduledPendingTurnFlushReason: 'turn-end' | 'abort' | null = null;
    const setPrimaryTurnInFlight = (value: boolean): void => {
        if (value && !turnInFlight) {
            void recordPrimaryTurnInProgress({ session: params.session });
        }
        turnInFlight = value;
    };
    const streamEventBridge = createCodexAppServerStreamEventBridge();
    const streamLifecycle = createCodexAppServerStreamLifecycle({
        session: params.session,
        transcriptSession: params.transcriptSession,
        readLastObservedMessageSeq: () => readLastObservedMessageSeq(params.session),
        getPendingTurn: () => pendingTurn,
    });
    const runtimeControlState = createCodexAppServerRuntimeControlState({
        directory: params.directory,
        onThinkingChange: params.onThinkingChange,
        getPermissionMode: params.getPermissionMode,
        permissionMode: params.permissionMode,
        getPendingTurn: () => pendingTurn,
        getLatestPendingTurnId: () => latestPendingTurnId,
    });
    const requestHandlers = createCodexAppServerRequestHandlers({
        permissionHandler: params.permissionHandler,
        onServerRequest: (input) => streamEventBridge.onServerRequest(input),
    });

    const pendingTurnLifecycle = createCodexAppServerPendingTurnLifecycle({
        session: params.session,
        completedTurnSeqRanges,
        assistantReasoningProjector: streamLifecycle.assistantReasoningProjector,
        turnDiffProjector: streamLifecycle.turnDiffProjector,
        runBridgeWork: streamLifecycle.runBridgeWork,
        setThinking: runtimeControlState.setThinking,
        setTurnInFlight: setPrimaryTurnInFlight,
        readLastObservedMessageSeq: () => readLastObservedMessageSeq(params.session),
        readLastObservedUserMessageSeq: () => readLastObservedUserMessageSeq(params.session),
        getPendingTurn: () => pendingTurn,
        setPendingTurn: (turn) => {
            pendingTurn = turn;
        },
        getLatestPendingTurnId: () => latestPendingTurnId,
        setLatestPendingTurnId: (turnId) => {
            latestPendingTurnId = turnId;
        },
        getPendingTurnStartSeqInclusive: () => pendingTurnStartSeqInclusive,
        setPendingTurnStartSeqInclusive: (value) => {
            pendingTurnStartSeqInclusive = value;
        },
        getPendingTurnFinalizationTimer: () => pendingTurnFinalizationTimer,
        setPendingTurnFinalizationTimer: (timer) => {
            pendingTurnFinalizationTimer = timer;
        },
        getScheduledPendingTurnFlushReason: () => scheduledPendingTurnFlushReason,
        setScheduledPendingTurnFlushReason: (reason) => {
            scheduledPendingTurnFlushReason = reason;
        },
    });
    const clientLifecycle = createCodexAppServerClientLifecycle({
        directory: params.directory,
        ...(params.processEnv ? { processEnv: params.processEnv } : {}),
        ...(params.configOverrides ? { configOverrides: params.configOverrides } : {}),
        activeServerDir: params.activeServerDir ?? null,
        session: params.session,
        runtimeEnv,
        getPendingTurn: () => pendingTurn,
        setPendingTurn: (turn) => {
            pendingTurn = turn;
        },
        getLatestPendingTurnId: () => latestPendingTurnId,
        setLatestPendingTurnId: (turnId) => {
            latestPendingTurnId = turnId;
        },
        getThreadId: () => threadId,
        setThreadId: (nextThreadId) => {
            threadId = nextThreadId;
        },
        getCurrentModelId: () => currentModelId,
        setCurrentModelId: (modelId) => {
            currentModelId = modelId;
        },
        getCurrentModeId: () => currentModeId,
        getCurrentReasoningEffort: () => currentReasoningEffort,
        getCurrentServiceTier: () => currentServiceTier,
        setCurrentServiceTier: (serviceTier) => {
            currentServiceTier = serviceTier;
        },
        hasServiceTierOverride: () => hasServiceTierOverride,
        setTurnInFlight: setPrimaryTurnInFlight,
        setThinking: runtimeControlState.setThinking,
        lastPublishedThreadId,
        runBridgeWork: streamLifecycle.runBridgeWork,
        ensureSyntheticSubagentThread: streamLifecycle.ensureSyntheticSubagentThread,
        finalizeSyntheticSubagentThread: streamLifecycle.finalizeSyntheticSubagentThread,
        streamEventBridge,
        applyStreamUpdate: streamLifecycle.applyStreamUpdate,
        handleServerRequest: requestHandlers.handleServerRequest,
        handleMcpElicitationRequest: requestHandlers.handleMcpElicitationRequest,
        notificationMatchesPendingTurn: pendingTurnLifecycle.notificationMatchesPendingTurn,
        resolveStreamUpdateContext: pendingTurnLifecycle.resolveStreamUpdateContext,
        schedulePendingTurnFinalization: pendingTurnLifecycle.schedulePendingTurnFinalization,
        abortPendingTurnWithFailure: pendingTurnLifecycle.abortPendingTurnWithFailure,
        resolveCurrentPolicy: runtimeControlState.resolveCurrentPolicy,
        finishPendingTurn: pendingTurnLifecycle.finishPendingTurn,
    });

    const runtimeOperations = createCodexAppServerRuntimeOperations({
        ensureClient: clientLifecycle.ensureClient,
        startOrLoad: clientLifecycle.startOrLoad,
        waitForActiveTurnId: runtimeControlState.waitForActiveTurnId,
        finishPendingTurn: pendingTurnLifecycle.finishPendingTurn,
        createPendingTurn,
        readLastObservedMessageSeq: () => readLastObservedMessageSeq(params.session),
        beginTurnDiffProjection: () => streamLifecycle.turnDiffProjector.beginTurn(),
        resolveCurrentPolicy: runtimeControlState.resolveCurrentPolicy,
        getThreadId: () => threadId,
        getPendingTurn: () => pendingTurn,
        setPendingTurn: (turn) => {
            pendingTurn = turn;
        },
        getLatestPendingTurnId: () => latestPendingTurnId,
        setLatestPendingTurnId: (turnId) => {
            latestPendingTurnId = turnId;
        },
        getCurrentModeId: () => currentModeId,
        setCurrentModeId: (modeId) => {
            currentModeId = modeId;
        },
        getCurrentModelId: () => currentModelId,
        setCurrentModelId: (modelId) => {
            currentModelId = modelId;
        },
        getCurrentReasoningEffort: () => currentReasoningEffort,
        setCurrentReasoningEffort: (value) => {
            currentReasoningEffort = value;
        },
        getCurrentServiceTier: () => currentServiceTier,
        setCurrentServiceTier: (value) => {
            currentServiceTier = value;
        },
        hasServiceTierOverride: () => hasServiceTierOverride,
        setHasServiceTierOverride: (value) => {
            hasServiceTierOverride = value;
        },
        setPendingTurnStartSeqInclusive: (value) => {
            pendingTurnStartSeqInclusive = value;
        },
        setTurnInFlight: setPrimaryTurnInFlight,
        setThinking: runtimeControlState.setThinking,
        publishSessionControls: async () => {
            const client = await clientLifecycle.ensureClient();
            await clientLifecycle.publishSessionControls(client);
        },
        disposeClient: clientLifecycle.disposeClient,
        sendSessionStatusMessage: (message) => {
            params.session.sendSessionEvent({ type: 'message', message });
        },
    });

    return {
        getSessionId: () => threadId,
        // Codex app-server exposes `turn/steer`, which appends user input to the active in-flight
        // turn without interrupting it. This may not affect a currently-running tool until that
        // tool finishes, but it should still be handled within the same turn.
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => turnInFlight,
        beginTurn: runtimeOperations.beginTurn,
        cancel: runtimeOperations.cancel,
        reset: runtimeOperations.reset,
        startOrLoad: clientLifecycle.startOrLoad,
        setSessionMode: runtimeOperations.setSessionMode,
        setSessionModel: runtimeOperations.setSessionModel,
        setSessionConfigOption: runtimeOperations.setSessionConfigOption,
        steerPrompt: runtimeOperations.steerPrompt,
        sendPrompt: runtimeOperations.sendPrompt,
        flushTurn: runtimeOperations.flushTurn,
        beginTurnLifecycle: runtimeOperations.beginTurn,
        startOrLoadSession: runtimeOperations.startOrLoadSession,
        sendTurnPrompt: runtimeOperations.sendPrompt,
        steerInFlightTurn: runtimeOperations.steerPrompt,
        waitForTurnCompletion: async () => {
            await runtimeOperations.flushTurn();
        },
        subscribeRuntimeMessages: () => () => undefined,
        respondToPermission: async () => undefined,
        cancelTurn: runtimeOperations.cancel,
        readSessionIdentity: () => ({
            sessionId: threadId,
        }),
        updateSessionRuntimeConfig: runtimeOperations.updateSessionRuntimeConfig,
        resetOrDisposeRuntime: runtimeOperations.reset,
        rollbackConversation: async (request: SessionRollbackRpcParams) =>
            await rollbackCodexAppServerConversation({
                threadId,
                pendingTurn,
                request,
                completedTurnSeqRanges,
                ensureClient: clientLifecycle.ensureClient,
                finishPendingTurn: pendingTurnLifecycle.finishPendingTurn,
                session: params.session,
            }),
    };
}
