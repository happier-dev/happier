import { storage } from '@/sync/domains/state/storage';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import type { VoiceAssistantAction } from '@happier-dev/protocol/voice/actions';
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
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { createVoiceTextTurnRejectedBeforeEffectError } from '@/voice/session/types';

export function createVoiceTurnStreaming(args: Readonly<{
    getVoiceAgentHandle: (sessionId: string) => Promise<VoiceAgentHandle>;
    interruptActiveTurn: (sessionId: string) => void;
    resetCachedHandle: (sessionId: string) => void;
    trackActiveTurn: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
    voiceAttemptExplicitContextBySessionId: Map<string, string[]>;
    deferredTargetSessionContextBySessionId: Map<string, (() => string) | null>;
    latestAutomaticUiContextBySessionId: Map<string, string>;
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
        let preparedAttemptContext: readonly string[] = [];
        const preparePayloadText = (): string => {
            if (preparedPayloadText !== null) return preparedPayloadText;

            preparedAttemptContext = args.voiceAttemptExplicitContextBySessionId.get(sessionId) ?? [];
            const deferredTargetSessionContext = args.deferredTargetSessionContextBySessionId.get(sessionId)?.();
            const latestAutomaticUiContext = args.latestAutomaticUiContextBySessionId.get(sessionId);
            const automaticUiContext =
                latestAutomaticUiContext
                && readVoicePrivacySettings(storage.getState().settings).currentUiContextMode === 'automatic'
                    ? latestAutomaticUiContext
                    : null;
            const pendingContext = [
                ...(options?.context ? [options.context] : []),
                ...(deferredTargetSessionContext ? [deferredTargetSessionContext] : []),
                ...preparedAttemptContext,
                ...(automaticUiContext ? [automaticUiContext] : []),
            ];
            const nextPayloadText = userText;
            if (deferredTargetSessionContext) {
                args.deferredTargetSessionContextBySessionId.set(sessionId, null);
            }
            if (latestAutomaticUiContext) {
                args.latestAutomaticUiContextBySessionId.delete(sessionId);
            }
            const payload = buildVoiceAgentTurnPayload({
                sessionId,
                userText: nextPayloadText,
                pendingContext,
            });
            preparedPayloadText = payload.payloadText;
            return preparedPayloadText;
        };

        const retireAcceptedAttemptContext = (): void => {
            if (preparedAttemptContext.length === 0) return;
            const current = args.voiceAttemptExplicitContextBySessionId.get(sessionId) ?? [];
            const stillHasPreparedPrefix = current.length >= preparedAttemptContext.length
                && preparedAttemptContext.every((value, index) => current[index] === value);
            if (!stillHasPreparedPrefix) return;
            const remaining = current.slice(preparedAttemptContext.length);
            if (remaining.length === 0) {
                args.voiceAttemptExplicitContextBySessionId.delete(sessionId);
                return;
            }
            args.voiceAttemptExplicitContextBySessionId.set(sessionId, remaining);
        };

        const sendWithHandle = async (displayUserText: string) => {
            const handle = await args.getVoiceAgentHandle(sessionId).catch((error: unknown) => {
                // A recovery can follow a prior dispatch; do not infer its outcome
                // from the later failure to reacquire a handle.
                if (lastHandle) throw error;
                // Initial acquisition has not received this input: no transcript
                // commit or turn dispatch can have happened for it.
                throw createVoiceTextTurnRejectedBeforeEffectError(error, 'provider_unavailable_before_acceptance');
            });
            lastHandle = handle;
            const nextUserText = preparePayloadText();
            const submittedUserLocalId = options?.userTranscript?.localId;
            const transcriptBaseline = submittedUserLocalId
                ? captureAssistantTextMessageBaseline(handle.rpcSessionId)
                : null;
            const settings: any = storage.getState().settings;
            const localConversation = readLocalConversationSettingsFromAccountSettings(settings);
            const streamingEnabled = localConversation.streaming.enabled === true;
            const send = async () => streamingEnabled
                ? await streamVoiceAgentTurn({
                    sessionId,
                    handle,
                    userText: nextUserText,
                    displayUserText,
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
                    ...(options?.onPreparedInstructionsFor
                        ? { onPreparedInstructionsFor: options.onPreparedInstructionsFor }
                        : {}),
                });
            const toolTurn = { turnOrigin: options?.turnOrigin,
                ...(options?.playHostText ? { playHostText: options.playHostText } : {}) };
            if (handle.toolTurnContext) handle.toolTurnContext.current = toolTurn;
            let response: Awaited<ReturnType<typeof send>>;
            try {
                response = await send();
            } finally {
                if (handle.toolTurnContext?.current === toolTurn) delete handle.toolTurnContext.current;
            }
            const normalizedResponse = {
                assistantText: response.assistantText,
                actions: streamingEnabled
                    ? response.actions ?? []
                    : withClientTurnEffectIdentity(handle, response.actions ?? []),
            };
            if (normalizedResponse.assistantText.trim().length === 0 && submittedUserLocalId && transcriptBaseline) {
                const messages = readStoredSessionMessages(storage.getState(), handle.rpcSessionId);
                const submittedUserIndex = messages.findIndex((message) =>
                    message.kind === 'user-text' && message.localId === submittedUserLocalId);
                // History can hydrate after baseline capture. Recover only after
                // the admitted input, using the same boundary as the direct waiter.
                const recoveredAssistantTexts = submittedUserIndex < 0 ? [] : collectAssistantTextMessagesSinceBaseline(
                    handle.rpcSessionId,
                    transcriptBaseline.baselineIds,
                    submittedUserIndex + 1,
                );
                const recoveredAssistantText = recoveredAssistantTexts.at(-1)?.trim() ?? '';
                if (recoveredAssistantText) {
                    retireAcceptedAttemptContext();
                    return {
                        assistantText: recoveredAssistantText,
                        actions: normalizedResponse.actions,
                    };
                }
            }
            retireAcceptedAttemptContext();
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
