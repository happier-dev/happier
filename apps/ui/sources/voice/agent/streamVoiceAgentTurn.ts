import { storage } from '@/sync/domains/state/storage';

import { createAbortRacer } from './voiceAgentAbort';
import { resolveVoiceTurnStreamReadConfig } from './resolveVoiceTurnStreamReadConfig';
import {
    attachVoiceAgentActionEffectId,
    type VoiceAgentHandle,
    type VoiceAgentSendTurnOptions,
    type VoiceAgentStartParams,
} from './types';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { createLegacyVoiceOutputAdapter } from './legacyVoiceOutputAdapter';
import { sanitizeVoiceOutputEventForDisplay } from './sanitizeVoiceOutputEventForDisplay';

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
        await abort.race(Promise.resolve(params.onStreamStarted?.(started.streamId)));
        abort.throwIfAborted();

        let cursor = 0;
        const outputAdapter = createLegacyVoiceOutputAdapter({ streamId: started.streamId });
        let mergedDeltaText = '';
        let doneAssistantText: string | null = null;
        let doneActions: NonNullable<Awaited<ReturnType<VoiceAgentHandle['client']['sendTurn']>>['actions']> = [];
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
                    const outputEvent = sanitizeVoiceOutputEventForDisplay(rawOutputEvent);
                    await abort.race(Promise.resolve(params.options?.onOutputEvent?.(outputEvent)));
                    if (outputEvent.kind === 'speech_segment') {
                        mergedDeltaText += outputEvent.text;
                    } else if (outputEvent.kind === 'side_effect') {
                        doneActions.push(attachVoiceAgentActionEffectId(outputEvent.action, outputEvent.effectId));
                    } else if (outputEvent.kind === 'turn_final') {
                        doneAssistantText = outputEvent.text;
                    } else if (outputEvent.kind === 'turn_cancelled') {
                        terminalCancellationObserved = true;
                        throw Object.assign(new Error('stream_cancelled'), {
                            rpcErrorCode: 'cancelled' as const,
                        });
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
