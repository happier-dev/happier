import { describe, expect, it, vi } from 'vitest';

import { streamVoiceAgentTurn } from './streamVoiceAgentTurn';
import type { VoiceAgentHandle } from './types';

describe('streamVoiceAgentTurn', () => {
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
});
