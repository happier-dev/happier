import { storage } from '@/sync/domains/state/storage';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError, type RpcErrorCarrier } from '@/sync/runtime/rpcErrors';

import { createAbortRacer } from './voiceAgentAbort';
import { resolveVoiceTurnStreamReadConfig } from './resolveVoiceTurnStreamReadConfig';
import {
  attachVoiceAgentActionEffectId,
  type VoiceAgentHandle,
  type VoiceAgentSendTurnOptions,
  type VoiceAgentStartParams,
} from './types';
import { createVoiceTextTurnRejectedBeforeEffectError } from '@/voice/session/types';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { createLegacyVoiceOutputAdapter } from './legacyVoiceOutputAdapter';
import { sanitizeVoiceOutputEventForDisplay } from './sanitizeVoiceOutputEventForDisplay';
import {
    createVoiceAgentOutputTurnV1,
    ingestVoiceAgentOutputEventV1,
    type VoiceAgentOutputEffectV1,
} from '@happier-dev/protocol';

export async function streamVoiceAgentTurn(params: Readonly<{
    sessionId: string;
    handle: VoiceAgentHandle;
    userText: string;
    displayUserText: string;
    resume?: boolean;
    options?: VoiceAgentSendTurnOptions;
    onStreamStarted?: (streamId: string) => void | Promise<void>;
    onStreamFinished?: () => void | Promise<void>;
}>): Promise<Readonly<{ assistantText: string; actions: NonNullable<Awaited<ReturnType<VoiceAgentHandle['client']['sendTurn']>>['actions']> }>> {
    const abort = createAbortRacer(params.options?.signal);
    const resolveStreamReadConfig = () => {
        const settings: any = storage.getState().settings;
        const voiceCfg = readLocalConversationSettingsFromAccountSettings(settings);
        return resolveVoiceTurnStreamReadConfig(voiceCfg);
    };

    const streamCfg = resolveStreamReadConfig();

    let started: { streamId: string } | null = null;
    let terminalCancellationObserved = false;
    try {
        abort.throwIfAborted();
        started = await params.handle.client.startTurnStream({
            sessionId: params.handle.rpcSessionId,
            voiceAgentId: params.handle.voiceAgentId,
            userText: params.userText,
            displayUserText: params.displayUserText,
            ...(params.resume === true ? { resume: true } : {}),
            ...(params.options?.userTranscript ? { userTranscript: params.options.userTranscript } : {}),
        });
        await abort.race(Promise.resolve(params.options?.onUserTranscriptAccepted?.()));
        await abort.race(Promise.resolve(params.onStreamStarted?.(started.streamId)));
        abort.throwIfAborted();

        let cursor = 0;
        const outputAdapter = createLegacyVoiceOutputAdapter({ streamId: started.streamId });
        let mergedDeltaText = '';
        let doneAssistantText: string | null = null;
        let doneActions: NonNullable<Awaited<ReturnType<VoiceAgentHandle['client']['sendTurn']>>['actions']> = [];
        let outputTurn = createVoiceAgentOutputTurnV1(started.streamId);
        const startedAtMs = Date.now();

        while (true) {
            abort.throwIfAborted();
            const elapsedMs = Date.now() - startedAtMs;
            if (streamCfg.streamTimeoutMs !== null && elapsedMs >= streamCfg.streamTimeoutMs) break;

            const read = await abort.race(
                params.handle.client.readTurnStream({
                    sessionId: params.handle.rpcSessionId,
                    voiceAgentId: params.handle.voiceAgentId,
                    streamId: started.streamId,
                    cursor,
                    maxEvents: streamCfg.maxEvents,
                }),
            );

            const sourceCursorStart = cursor;
            cursor = read.nextCursor;

            for (const [eventIndex, event] of read.events.entries()) {
                const outputEvents = outputAdapter.ingest(sourceCursorStart + eventIndex, event);
                for (const rawOutputEvent of outputEvents) {
                    const ingested = ingestVoiceAgentOutputEventV1(outputTurn, rawOutputEvent);
                    outputTurn = ingested.state;
                    if (ingested.effects.length === 0) continue;
                    const outputEvent = sanitizeVoiceOutputEventForDisplay(rawOutputEvent);
                    const presentedEffects: readonly VoiceAgentOutputEffectV1[] = outputEvent.kind === 'display_status'
                        ? ingested.effects.map((effect) => effect.kind === 'display_status'
                            ? { ...effect, text: outputEvent.text }
                            : effect)
                        : ingested.effects;
                    await abort.race(Promise.resolve(params.options?.onOutputEvent?.({
                        event: outputEvent,
                        effects: presentedEffects,
                    })));
                    for (const effect of presentedEffects) {
                        if (effect.kind === 'speak') {
                            mergedDeltaText += effect.text;
                        } else if (effect.kind === 'execute_side_effect') {
                            doneActions.push(attachVoiceAgentActionEffectId(effect.action, effect.effectId));
                        } else if (effect.kind === 'persist_final') {
                            doneAssistantText = effect.text;
                        } else if (effect.kind === 'cancel_turn') {
                            terminalCancellationObserved = true;
                            throw Object.assign(new Error('stream_cancelled'), {
                                rpcErrorCode: 'cancelled' as const,
                            });
                        }
                    }
                }
                if (event.t !== 'error') continue;
                if (event.t === 'error') {
                    throw Object.assign(new Error(event.error || 'stream_failed'), {
                        rpcErrorCode: event.errorCode,
                    });
                }
            }

            if (read.done) {
                return { assistantText: (doneAssistantText ?? mergedDeltaText).trim(), actions: doneActions };
            }

            if (streamCfg.streamTimeoutMs === null) {
                await abort.race(new Promise((resolve) => setTimeout(resolve, streamCfg.pollIntervalMs)));
                continue;
            }

            const remainingMs = streamCfg.streamTimeoutMs - (Date.now() - startedAtMs);
            if (remainingMs <= 0) break;
            await abort.race(new Promise((resolve) => setTimeout(resolve, Math.min(streamCfg.pollIntervalMs, remainingMs))));
        }

        throw new Error('stream_timeout');
    } catch (error) {
        if (!started) {
            const carrier: RpcErrorCarrier = error && typeof error === 'object'
                ? error as RpcErrorCarrier
                : { message: typeof error === 'string' ? error : undefined };
            if (isRpcMethodNotAvailableError(carrier) || isRpcMethodNotFoundError(carrier)) {
                throw createVoiceTextTurnRejectedBeforeEffectError(
                    error,
                    'provider_unavailable_before_acceptance',
                );
            }
        }
        if (started && !terminalCancellationObserved) {
            await params.handle.client
                .cancelTurnStream({
                    sessionId: params.handle.rpcSessionId,
                    voiceAgentId: params.handle.voiceAgentId,
                    streamId: started.streamId,
                })
                .catch(() => {});
        }
        throw error;
    } finally {
        if (started) {
            await Promise.resolve(params.onStreamFinished?.()).catch(() => {});
        }
        abort.dispose();
    }
}
