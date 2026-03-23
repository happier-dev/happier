import { storage } from '@/sync/domains/state/storage';

import { createAbortRacer } from './voiceAgentAbort';
import { resolveVoiceTurnStreamReadConfig } from './resolveVoiceTurnStreamReadConfig';
import type { VoiceAgentHandle, VoiceAgentStartParams } from './types';

type SendTurnOptions = Readonly<{ onTextDelta?: (textDelta: string) => void | Promise<void>; signal?: AbortSignal }>;

export async function streamVoiceAgentTurn(params: Readonly<{
    sessionId: string;
    handle: VoiceAgentHandle;
    userText: string;
    displayUserText: string;
    options?: SendTurnOptions;
}>): Promise<Readonly<{ assistantText: string; actions: NonNullable<Awaited<ReturnType<VoiceAgentHandle['client']['sendTurn']>>['actions']> }>> {
    const abort = createAbortRacer(params.options?.signal);
    const resolveStreamReadConfig = () => {
        const settings: any = storage.getState().settings;
        const voiceCfg = settings?.voice?.adapters?.local_conversation ?? null;
        return resolveVoiceTurnStreamReadConfig(voiceCfg);
    };

    const streamCfg = resolveStreamReadConfig();
    const shouldResumeStreamStart = (() => {
        if (params.handle.backend !== 'daemon') return false;
        const settings: any = storage.getState().settings;
        const agentCfg = settings?.voice?.adapters?.local_conversation?.agent ?? null;
        return agentCfg?.transcript?.persistenceMode === 'persistent' && agentCfg?.resumabilityMode === 'provider_resume';
    })();

    let started: { streamId: string } | null = null;
    try {
        abort.throwIfAborted();
        started = await params.handle.client.startTurnStream({
            sessionId: params.handle.rpcSessionId,
            voiceAgentId: params.handle.voiceAgentId,
            userText: params.userText,
            displayUserText: params.displayUserText,
            ...(shouldResumeStreamStart ? { resume: true } : {}),
        });
        abort.throwIfAborted();

        let cursor = 0;
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

            cursor = read.nextCursor;

            for (const event of read.events) {
                if (event.t === 'delta' && typeof event.textDelta === 'string') {
                    await abort.race(Promise.resolve(params.options?.onTextDelta?.(event.textDelta)));
                    mergedDeltaText += event.textDelta;
                    continue;
                }
                if (event.t === 'done') {
                    doneAssistantText = event.assistantText;
                    doneActions = event.actions ?? [];
                    continue;
                }
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
        if (started) {
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
        abort.dispose();
    }
}
