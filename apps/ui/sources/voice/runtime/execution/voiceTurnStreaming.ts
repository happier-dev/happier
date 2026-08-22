import { storage } from '@/sync/domains/state/storage';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import {
    attachVoiceAgentActionEffectId,
    type VoiceAgentHandle,
    type VoiceAgentSendTurnOptions,
} from '@/voice/agent/types';
import {
    captureAssistantTextMessageBaseline,
    collectAssistantTextMessagesSinceBaseline,
} from '@/voice/runtime/waitForNextAssistantTextMessage';
import { isVoiceAgentNotFoundError, isVoiceAgentRpcMethodUnavailable } from '@/voice/agent/voiceAgentErrorGuards';
import { clearStaleDaemonRunState } from '@/voice/agent/voiceAgentRunState';
import { streamVoiceAgentTurn } from '@/voice/agent/streamVoiceAgentTurn';
import { buildVoiceAgentTurnPayload } from '@/voice/agent/buildVoiceAgentTurnPayload';
import { readPersistedVoiceConversationRuntimePublication } from '@/voice/binding/voiceConversationBindingPersistence';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';

export function createVoiceTurnStreaming(args: Readonly<{
    getVoiceAgentHandle: (sessionId: string) => Promise<VoiceAgentHandle>;
    interruptActiveTurn: (sessionId: string) => void;
    resetCachedHandle: (sessionId: string) => void;
    trackActiveTurn: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
    voiceAgentPendingContextBySessionId: Map<string, string[]>;
    voiceAgentTurnAbortControllerBySessionId: Map<string, AbortController>;
}>): Readonly<{
    sendInterruptingTextUpdate: (
        sessionId: string,
        update: string,
        options?: VoiceAgentSendTurnOptions,
    ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
    sendTextUpdate: (
        sessionId: string,
        update: string,
    ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
    sendTurn: (
        sessionId: string,
        userText: string,
        options?: VoiceAgentSendTurnOptions,
    ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
}> {
    const readDaemonRuntimePublication = (managedSessionId: string) =>
        readPersistedVoiceConversationRuntimePublication({ managedSessionId });

    /**
     * The eager stream carries a per-effect call identity, and the local tool runner refuses to
     * execute a non-read-only effect without one. The non-eager client turn has no stream, so this
     * seam - the one producer of both turn shapes - stamps the same process-local identity from the
     * RPC session plus a monotonic turn ordinal. Identity is stable for every action of one turn
     * response and distinct across turns, exactly matching the streamed guarantee.
     */
    let clientTurnOrdinal = 0;
    const withClientTurnEffectIdentity = (
        handle: VoiceAgentHandle,
        actions: readonly VoiceAssistantAction[],
    ): VoiceAssistantAction[] => {
        if (actions.length === 0) return [];
        clientTurnOrdinal += 1;
        const turnOrdinal = clientTurnOrdinal;
        return actions.map((action, index) => attachVoiceAgentActionEffectId(
            action,
            `${handle.rpcSessionId}:client:${turnOrdinal}:${index}`,
        ));
    };

    const sendTurnImpl = async (
        sessionId: string,
        userText: string,
        options?: VoiceAgentSendTurnOptions,
    ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> => {
        let lastHandle: VoiceAgentHandle | null = null;
        let preparedPayloadText: string | null = null;
        const preparePayloadText = (): string => {
            if (preparedPayloadText !== null) return preparedPayloadText;

            const pendingContext = args.voiceAgentPendingContextBySessionId.get(sessionId) ?? [];
            const nextPayloadText = userText;
            if (pendingContext.length > 0) {
                args.voiceAgentPendingContextBySessionId.delete(sessionId);
            }
            const payload = buildVoiceAgentTurnPayload({
                sessionId,
                userText: nextPayloadText,
                pendingContext,
            });
            preparedPayloadText = payload.payloadText;
            return preparedPayloadText;
        };

        const sendWithHandle = async (displayUserText: string) => {
            const handle = await args.getVoiceAgentHandle(sessionId);
            lastHandle = handle;
            const nextUserText = preparePayloadText();
            const transcriptBaseline = captureAssistantTextMessageBaseline(handle.rpcSessionId);
            const settings: any = storage.getState().settings;
            const localConversation = readLocalConversationSettingsFromAccountSettings(settings);
            const streamingEnabled = localConversation.streaming.enabled === true;
            const daemonRuntimePublication =
                handle.backend === 'daemon'
                    ? readDaemonRuntimePublication(sessionId)
                    : null;
            const shouldResumeStreamStart =
                handle.backend === 'daemon'
                && daemonRuntimePublication?.facets?.transcriptSource?.supported === true
                && localConversation.agent.transcript.persistenceMode === 'persistent'
                && localConversation.agent.resumabilityMode === 'provider_resume';

            const response = streamingEnabled
                ? await streamVoiceAgentTurn({
                    sessionId,
                    handle,
                    userText: nextUserText,
                    displayUserText,
                    resume: shouldResumeStreamStart,
                    options,
                })
                : await handle.client.sendTurn({
                    sessionId: handle.rpcSessionId,
                    voiceAgentId: handle.voiceAgentId,
                    userText: nextUserText,
                    displayUserText,
                    ...(options?.signal ? { signal: options.signal } : {}),
                    ...(options?.userTranscript ? { userTranscript: options.userTranscript } : {}),
                    ...(options?.onUserTranscriptAccepted
                        ? { onUserTranscriptAccepted: options.onUserTranscriptAccepted }
                        : {}),
                });
            const normalizedResponse = {
                assistantText: response.assistantText,
                actions: streamingEnabled
                    ? response.actions ?? []
                    : withClientTurnEffectIdentity(handle, response.actions ?? []),
            };
            if (
                normalizedResponse.assistantText.trim().length === 0
            ) {
                const recoveredAssistantTexts = collectAssistantTextMessagesSinceBaseline(
                    handle.rpcSessionId,
                    transcriptBaseline.baselineIds,
                    transcriptBaseline.baselineCount,
                );
                const recoveredAssistantText = recoveredAssistantTexts.at(-1)?.trim() ?? '';
                if (recoveredAssistantText) {
                    return {
                        assistantText: recoveredAssistantText,
                        actions: normalizedResponse.actions,
                    };
                }
            }
            return normalizedResponse;
        };

        try {
            return await sendWithHandle(userText);
        } catch (error) {
            if (isVoiceAgentRpcMethodUnavailable(error)) {
                await clearStaleDaemonRunState(sessionId, lastHandle).catch(() => {});
                args.resetCachedHandle(sessionId);
                return await sendWithHandle(userText);
            }
            if (!isVoiceAgentNotFoundError(error)) throw error;
            args.resetCachedHandle(sessionId);
            return await sendWithHandle(userText);
        }
    };

    const sendTurn = async (
        sessionId: string,
        userText: string,
        options?: VoiceAgentSendTurnOptions,
    ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> =>
        await args.trackActiveTurn(sessionId, async () => {
            const internalAbortController = new AbortController();
            args.voiceAgentTurnAbortControllerBySessionId.set(sessionId, internalAbortController);
            const mergedSignals = [options?.signal, internalAbortController.signal].filter(Boolean) as AbortSignal[];
            const mergedAbort = (() => {
                if (mergedSignals.length === 1) {
                    return {
                        signal: mergedSignals[0],
                        dispose: () => undefined,
                    };
                }
                const controller = new AbortController();
                const onAbort = () => controller.abort();
                for (const signal of mergedSignals) {
                    if (signal.aborted) controller.abort();
                    signal.addEventListener('abort', onAbort, { once: true });
                }
                return {
                    signal: controller.signal,
                    dispose: () => {
                        for (const signal of mergedSignals) {
                            signal.removeEventListener('abort', onAbort);
                        }
                    },
                };
            })();
            try {
                return await sendTurnImpl(sessionId, userText, { ...options, signal: mergedAbort.signal });
            } finally {
                mergedAbort.dispose();
                if (args.voiceAgentTurnAbortControllerBySessionId.get(sessionId) === internalAbortController) {
                    args.voiceAgentTurnAbortControllerBySessionId.delete(sessionId);
                }
            }
        });

    const sendInterruptingTextUpdate = async (
        sessionId: string,
        update: string,
        options?: VoiceAgentSendTurnOptions,
    ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> => {
        const text = update.trim();
        if (!text) {
            return { assistantText: '', actions: [] };
        }

        args.interruptActiveTurn(sessionId);
        return await sendTurn(sessionId, text, options);
    };

    const sendTextUpdate = async (
        sessionId: string,
        update: string,
    ): Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>> => {
        const text = update.trim();
        if (!text) {
            return { assistantText: '', actions: [] };
        }

        return await sendTurn(sessionId, text);
    };

    return {
        sendInterruptingTextUpdate,
        sendTextUpdate,
        sendTurn,
    };
}
