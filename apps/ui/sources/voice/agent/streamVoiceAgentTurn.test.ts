import { describe, expect, it, vi } from 'vitest';

import { streamVoiceAgentTurn } from './streamVoiceAgentTurn';
import { readVoiceAgentActionEffectId, type VoiceAgentHandle } from './types';
import type { VoiceAgentOutputEventV1 } from '@happier-dev/protocol';

describe('streamVoiceAgentTurn', () => {
    it('projects the legacy daemon wire through the single canonical output-event boundary', async () => {
        const onOutputEvent = vi.fn(async (_event: VoiceAgentOutputEventV1) => {});
        const handle = {
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: {
                start: vi.fn(), sendTurn: vi.fn(), welcome: vi.fn(),
                startTurnStream: vi.fn(async () => ({ streamId: 'stream-1' })),
                readTurnStream: vi.fn(async () => ({
                    streamId: 'stream-1',
                    events: [
                        { t: 'delta' as const, textDelta: 'Hello ' },
                        { t: 'done' as const, assistantText: 'Hello world', actions: [{ t: 'sendSessionMessage', args: { message: 'Do it' } }] },
                    ],
                    nextCursor: 2,
                    done: true,
                })),
                cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
                commit: vi.fn(), stop: vi.fn(),
            },
        } satisfies VoiceAgentHandle;

        const result = await streamVoiceAgentTurn({
            sessionId: 'sys_voice', handle, userText: 'hello', displayUserText: 'hello',
            options: { onOutputEvent },
        });

        expect(onOutputEvent.mock.calls.map(([event]) => event.kind)).toEqual([
            'speech_segment', 'side_effect', 'turn_final',
        ]);
        expect(onOutputEvent.mock.calls.map(([event]) => event.seq)).toEqual([0, 1, 2]);
        expect(result.actions).toEqual([{ t: 'sendSessionMessage', args: { message: 'Do it' } }]);
        expect(readVoiceAgentActionEffectId(result.actions[0])).toBe('stream-1:legacy:1:0');
    });

    it('reports stream lifecycle callbacks around a completed streamed turn', async () => {
        const onStreamStarted = vi.fn(async (_streamId: string) => {});
        const onStreamFinished = vi.fn(async () => {});
        const startTurnStream = vi.fn(async () => ({ streamId: 'stream-1' }));
        const readTurnStream = vi.fn(async () => ({
            streamId: 'stream-1',
            events: [{ t: 'done' as const, assistantText: 'ok', actions: [] }],
            nextCursor: 1,
            done: true,
        }));

        const handle = {
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: {
                start: vi.fn(),
                sendTurn: vi.fn(),
                welcome: vi.fn(),
                startTurnStream,
                readTurnStream,
                cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
                commit: vi.fn(),
                stop: vi.fn(),
            },
        } satisfies VoiceAgentHandle;

        await expect(
            streamVoiceAgentTurn({
                sessionId: 'sys_voice',
                handle,
                userText: 'hello',
                displayUserText: 'hello',
                onStreamStarted,
                onStreamFinished,
            }),
        ).resolves.toEqual({ assistantText: 'ok', actions: [] });

        expect(startTurnStream).toHaveBeenCalledTimes(1);
        expect(readTurnStream).toHaveBeenCalledTimes(1);
        expect(onStreamStarted).toHaveBeenCalledWith('stream-1');
        expect(onStreamFinished).toHaveBeenCalledTimes(1);
    });

    it('surfaces a daemon terminal cancellation instead of returning an empty successful turn', async () => {
        const cancelTurnStream = vi.fn(async () => ({ ok: true as const }));
        const handle = {
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: {
                start: vi.fn(),
                sendTurn: vi.fn(),
                welcome: vi.fn(),
                startTurnStream: vi.fn(async () => ({ streamId: 'stream-cancelled' })),
                readTurnStream: vi.fn(async () => ({
                    streamId: 'stream-cancelled',
                    events: [{ t: 'cancelled' as const }],
                    nextCursor: 1,
                    done: true,
                })),
                cancelTurnStream,
                commit: vi.fn(),
                stop: vi.fn(),
            },
        } satisfies VoiceAgentHandle;

        await expect(streamVoiceAgentTurn({
            sessionId: 'sys_voice',
            handle,
            userText: 'cancel me',
            displayUserText: 'cancel me',
        })).rejects.toMatchObject({ message: 'stream_cancelled', rpcErrorCode: 'cancelled' });
        expect(cancelTurnStream).not.toHaveBeenCalled();
    });
});
