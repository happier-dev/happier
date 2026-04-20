import type {
    RuntimeTurnConfigUpdate,
    RuntimeTurnStartOrLoadOptions,
} from '@/agent/runtime/turns/runtimeTurnOperations';

import { resolveCodexAppServerCollaborationModeSelection } from '../sessionControlsMetadata';
import {
    readTurnId,
    trimSessionId,
    trimStringValue,
} from '../readCodexAppServerRpcFields';
import type { CodexAppServerStartOrLoadOptions } from '../startOrLoadThread';

type PendingTurn = Readonly<{
    threadId: string;
    turnId: string | null;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
}>;

export function createCodexAppServerRuntimeOperations(params: Readonly<{
    ensureClient: () => Promise<Readonly<{
        request: (method: string, params: unknown) => Promise<unknown>;
    }>>;
    startOrLoad: (options?: CodexAppServerStartOrLoadOptions) => Promise<void>;
    waitForActiveTurnId: () => Promise<string | null>;
    finishPendingTurn: (options?: Readonly<{ error?: Error; flushReason?: 'turn-end' | 'abort'; insideBridgeWork?: boolean }>) => Promise<void>;
    createPendingTurn: (threadId: string) => PendingTurn;
    readLastObservedMessageSeq: () => number;
    beginTurnDiffProjection: () => void;
    resolveCurrentPolicy: () => Readonly<{
        approvalPolicy: unknown;
        sandboxPolicy: unknown;
    }> | null;
    getThreadId: () => string | null;
    getPendingTurn: () => PendingTurn | null;
    setPendingTurn: (turn: PendingTurn | null) => void;
    getLatestPendingTurnId: () => string | null;
    setLatestPendingTurnId: (turnId: string | null) => void;
    getCurrentModeId: () => string | null;
    setCurrentModeId: (modeId: string | null) => void;
    getCurrentModelId: () => string | null;
    setCurrentModelId: (modelId: string | null) => void;
    getCurrentReasoningEffort: () => string | null;
    setCurrentReasoningEffort: (value: string | null) => void;
    getCurrentServiceTier: () => string | null;
    setCurrentServiceTier: (value: string | null) => void;
    hasServiceTierOverride: () => boolean;
    setHasServiceTierOverride: (value: boolean) => void;
    setPendingTurnStartSeqInclusive: (value: number | null) => void;
    setTurnInFlight: (value: boolean) => void;
    setThinking: (value: boolean) => void;
    publishSessionControls: () => Promise<void>;
    disposeClient: () => Promise<void>;
}>): Readonly<{
    setSessionMode: (mode: string) => Promise<void>;
    setSessionModel: (model: string) => Promise<void>;
    setSessionConfigOption: (key: string, value: unknown) => Promise<void>;
    steerPrompt: (prompt: string) => Promise<void>;
    sendPrompt: (prompt: string) => Promise<void>;
    flushTurn: () => Promise<void>;
    beginTurn: () => void;
    cancel: () => Promise<void>;
    reset: () => Promise<void>;
    startOrLoadSession: (options?: RuntimeTurnStartOrLoadOptions) => Promise<void>;
    updateSessionRuntimeConfig: (update: RuntimeTurnConfigUpdate) => Promise<void>;
}> {
    const setSessionMode = async (mode: string): Promise<void> => {
        const client = await params.ensureClient();
        const nextModeId = trimSessionId(mode);
        if (!nextModeId) {
            throw new Error('Codex app-server setSessionMode requires a non-empty mode id');
        }
        const selection = resolveCodexAppServerCollaborationModeSelection({
            modesResponse: await client.request('collaborationMode/list', {}),
            modelsResponse: await client.request('model/list', {}),
            modeId: nextModeId,
            currentModelId: params.getCurrentModelId(),
            currentReasoningEffort: params.getCurrentReasoningEffort(),
        });
        if (!selection) {
            throw new Error(`Unknown Codex app-server collaboration mode: ${mode}`);
        }
        params.setCurrentModeId(selection.modeId);
        await params.publishSessionControls();
    };

    const setSessionModel = async (model: string): Promise<void> => {
        params.setCurrentModelId(trimSessionId(model));
        await params.ensureClient();
        await params.publishSessionControls();
    };

    const setSessionConfigOption = async (key: string, value: unknown): Promise<void> => {
        if (key === 'reasoning_effort') {
            const nextReasoningEffort = trimStringValue(value);
            if (!nextReasoningEffort) {
                throw new Error('Codex app-server reasoning_effort requires a non-empty value');
            }
            params.setCurrentReasoningEffort(nextReasoningEffort);
            await params.ensureClient();
            await params.publishSessionControls();
            return;
        }
        if (key === 'service_tier' || key === 'speed') {
            const nextServiceTier = trimStringValue(value);
            if (nextServiceTier !== 'fast' && nextServiceTier !== 'standard') {
                throw new Error(`Unsupported Codex app-server Speed value: ${String(value)}`);
            }
            params.setCurrentServiceTier(nextServiceTier);
            params.setHasServiceTierOverride(true);
            await params.ensureClient();
            await params.publishSessionControls();
            return;
        }
        throw new Error(`Unsupported Codex app-server config option: ${String(key)}`);
    };

    const steerPrompt = async (prompt: string): Promise<void> => {
        const activeTurn = params.getPendingTurn();
        if (!activeTurn) {
            throw new Error('Codex app-server steerPrompt requires an active turn');
        }
        const client = await params.ensureClient();
        const expectedTurnId = (activeTurn.turnId ?? params.getLatestPendingTurnId()) ?? (await params.waitForActiveTurnId());
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
    };

    const sendPrompt = async (prompt: string): Promise<void> => {
        const activeThreadId = params.getThreadId();
        if (!activeThreadId) {
            throw new Error('Codex app-server sendPrompt requires an active thread');
        }
        if (params.getPendingTurn()) {
            throw new Error('Codex app-server already has a turn in flight');
        }
        const client = await params.ensureClient();
        params.setPendingTurnStartSeqInclusive(params.readLastObservedMessageSeq());
        params.beginTurnDiffProjection();
        const activeTurn = params.createPendingTurn(activeThreadId);
        params.setPendingTurn(activeTurn);
        params.setLatestPendingTurnId(null);
        params.setTurnInFlight(true);
        params.setThinking(true);
        try {
            // null policy (Happier 'default') → omit approvalPolicy/sandboxPolicy so Codex uses ~/.codex/config.toml.
            const policy = params.resolveCurrentPolicy();
            const policyFields = policy
                ? { approvalPolicy: policy.approvalPolicy, sandboxPolicy: policy.sandboxPolicy }
                : {};
            const currentModeId = params.getCurrentModeId();
            const collaborationMode = currentModeId
                ? resolveCodexAppServerCollaborationModeSelection({
                    modesResponse: await client.request('collaborationMode/list', {}),
                    modelsResponse: await client.request('model/list', {}),
                    modeId: currentModeId,
                    currentModelId: params.getCurrentModelId(),
                    currentReasoningEffort: params.getCurrentReasoningEffort(),
                })?.payload
                : null;
            const currentServiceTier = params.getCurrentServiceTier();
            const response = await client.request('turn/start', {
                threadId: activeThreadId,
                input: [{ type: 'text', text: prompt }],
                ...(params.getCurrentModelId() ? { model: params.getCurrentModelId() } : {}),
                ...(params.getCurrentReasoningEffort() ? { effort: params.getCurrentReasoningEffort() } : {}),
                ...(params.hasServiceTierOverride()
                    ? (currentServiceTier === 'fast' ? { serviceTier: 'fast' } : { serviceTier: null })
                    : {}),
                ...policyFields,
                ...(collaborationMode ? { collaborationMode } : {}),
            });
            const startedTurnId = readTurnId(response);
            if (startedTurnId) {
                params.setPendingTurn({ ...activeTurn, turnId: startedTurnId });
                params.setLatestPendingTurnId(startedTurnId);
            }
            await (params.getPendingTurn() ?? activeTurn).promise;
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            await params.finishPendingTurn({ error: failure, flushReason: 'abort' });
            throw failure;
        }
    };

    const flushTurn = async (): Promise<void> => {
        await params.finishPendingTurn({ flushReason: 'turn-end' });
    };

    const beginTurn = (): void => {
        params.beginTurnDiffProjection();
        params.setTurnInFlight(true);
        params.setThinking(true);
    };

    const cancel = async (): Promise<void> => {
        const activeTurn = params.getPendingTurn();
        if (!activeTurn) {
            params.setTurnInFlight(false);
            params.setThinking(false);
            return;
        }
        const client = await params.ensureClient();
        const interruptTurnId = (activeTurn.turnId ?? params.getLatestPendingTurnId()) ?? (await params.waitForActiveTurnId());
        if (!interruptTurnId) {
            await params.disposeClient();
            return;
        }
        await client.request('turn/interrupt', { threadId: activeTurn.threadId, turnId: interruptTurnId });
        await params.finishPendingTurn({ flushReason: 'abort' });
    };

    const reset = async (): Promise<void> => {
        params.setCurrentModeId(null);
        params.setCurrentModelId(null);
        params.setCurrentReasoningEffort(null);
        params.setCurrentServiceTier(null);
        await params.disposeClient();
        params.setTurnInFlight(false);
        params.setThinking(false);
    };

    return {
        setSessionMode,
        setSessionModel,
        setSessionConfigOption,
        steerPrompt,
        sendPrompt,
        flushTurn,
        beginTurn,
        cancel,
        reset,
        startOrLoadSession: async (options?: RuntimeTurnStartOrLoadOptions) => {
            await params.startOrLoad({
                ...(typeof options?.resumeId === 'string' ? { resumeId: options.resumeId } : {}),
                ...(typeof options?.importHistory === 'boolean' ? { importHistory: options.importHistory } : {}),
            });
        },
        updateSessionRuntimeConfig: async (update: RuntimeTurnConfigUpdate) => {
            if (typeof update.modeId === 'string') {
                await setSessionMode(update.modeId);
            }
            if (typeof update.modelId === 'string') {
                await setSessionModel(update.modelId);
            }
            if (update.configOption) {
                await setSessionConfigOption(update.configOption.id, update.configOption.value);
            }
        },
    };
}
