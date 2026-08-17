import { describe, expect, it, vi } from 'vitest';

import { streamVoiceAgentTurn } from './streamVoiceAgentTurn';
import {
    readVoiceAgentActionEffectId,
    type VoiceAgentAcceptedOutputV1,
    type VoiceAgentHandle,
} from './types';

describe('streamVoiceAgentTurn', () => {
    it('projects the legacy daemon wire through the single canonical output-event boundary', async () => {
        const onOutputEvent = vi.fn(async (_output: VoiceAgentAcceptedOutputV1) => {});
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

        expect(onOutputEvent.mock.calls.map(([output]) => output.event.kind)).toEqual([
            'speech_segment', 'side_effect', 'turn_final',
        ]);
        expect(onOutputEvent.mock.calls.map(([output]) => output.event.seq)).toEqual([0, 1, 2]);
        expect(result.actions).toEqual([{ t: 'sendSessionMessage', args: { message: 'Do it' } }]);
        expect(readVoiceAgentActionEffectId(result.actions[0])).toBe('stream-1:legacy:1:0');
    });

    it('returns and publishes a replayed stable side effect only once', async () => {
        const onOutputEvent = vi.fn(async (_output: VoiceAgentAcceptedOutputV1) => {});
        const action = { t: 'sendSessionMessage' as const, args: { message: 'Do it once' } };
        const handle = {
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: {
                start: vi.fn(), sendTurn: vi.fn(), welcome: vi.fn(),
                startTurnStream: vi.fn(async () => ({ streamId: 'stream-replay' })),
                readTurnStream: vi.fn(async () => ({
                    streamId: 'stream-replay',
                    events: [
                        {
                            t: 'voice_output' as const,
                            output: {
                                v: 1 as const,
                                kind: 'side_effect' as const,
                                turnId: 'stream-replay',
                                seq: 0,
                                effectId: 'effect-stable',
                                action,
                            },
                        },
                        {
                            t: 'voice_output' as const,
                            output: {
                                v: 1 as const,
                                kind: 'side_effect' as const,
                                turnId: 'stream-replay',
                                seq: 0,
                                effectId: 'effect-stable',
                                action,
                            },
                        },
                        {
                            t: 'voice_output' as const,
                            output: {
                                v: 1 as const,
                                kind: 'turn_final' as const,
                                turnId: 'stream-replay',
                                seq: 1,
                                text: 'Done',
                            },
                        },
                        {
                            t: 'voice_output' as const,
                            output: {
                                v: 1 as const,
                                kind: 'side_effect' as const,
                                turnId: 'stream-replay',
                                seq: 2,
                                effectId: 'effect-late',
                                action: { t: 'sendSessionMessage', args: { message: 'Too late' } },
                            },
                        },
                    ],
                    nextCursor: 4,
                    done: true,
                })),
                cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
                commit: vi.fn(), stop: vi.fn(),
            },
        } satisfies VoiceAgentHandle;

        const result = await streamVoiceAgentTurn({
            sessionId: 'sys_voice',
            handle,
            userText: 'do it',
            displayUserText: 'do it',
            options: { onOutputEvent },
        });

        expect(onOutputEvent.mock.calls.map(([output]) => output.event.kind)).toEqual([
            'side_effect',
            'turn_final',
        ]);
        expect(result.actions).toHaveLength(1);
        expect(result.actions[0]).toEqual(action);
        expect(readVoiceAgentActionEffectId(result.actions[0])).toBe('effect-stable');
    });

    it('enforces the canonical payload budget before display-status redaction', async () => {
        const onOutputEvent = vi.fn(async (_output: VoiceAgentAcceptedOutputV1) => {});
        const events = Array.from({ length: 240 }, (_, seq) => ({
            t: 'voice_output' as const,
            output: {
                v: 1 as const,
                kind: 'display_status' as const,
                turnId: 'stream-budget',
                seq,
                statusId: `status-${seq}`,
                text: `/Users/a/${'x'.repeat(1_015)}`,
            },
        }));
        const handle = {
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: {
                start: vi.fn(), sendTurn: vi.fn(), welcome: vi.fn(),
                startTurnStream: vi.fn(async () => ({ streamId: 'stream-budget' })),
                readTurnStream: vi.fn(async () => ({
                    streamId: 'stream-budget',
                    events,
                    nextCursor: events.length,
                    done: true,
                })),
                cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
                commit: vi.fn(), stop: vi.fn(),
            },
        } satisfies VoiceAgentHandle;

        await expect(streamVoiceAgentTurn({
            sessionId: 'sys_voice',
            handle,
            userText: 'status',
            displayUserText: 'status',
            options: { onOutputEvent },
        })).rejects.toThrow('voice_output_budget_exceeded');
        expect(onOutputEvent).toHaveBeenCalled();
        expect(onOutputEvent.mock.calls[0]?.[0].event).toMatchObject({
            kind: 'display_status',
            text: '<path_redacted>',
        });
        expect(onOutputEvent.mock.calls[0]?.[0].effects).toEqual([{
            kind: 'display_status',
            statusId: 'status-0',
            text: '<path_redacted>',
        }]);
    });

    it('fails closed on a unique out-of-order native event at the Protocol owner', async () => {
        const handle = {
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: {
                start: vi.fn(), sendTurn: vi.fn(), welcome: vi.fn(),
                startTurnStream: vi.fn(async () => ({ streamId: 'stream-order' })),
                readTurnStream: vi.fn(async () => ({
                    streamId: 'stream-order',
                    events: [{
                        t: 'voice_output' as const,
                        output: {
                            v: 1 as const,
                            kind: 'display_status' as const,
                            turnId: 'stream-order',
                            seq: 1,
                            statusId: 'status-1',
                            text: 'Skipped zero',
                        },
                    }],
                    nextCursor: 1,
                    done: true,
                })),
                cancelTurnStream: vi.fn(async () => ({ ok: true as const })),
                commit: vi.fn(), stop: vi.fn(),
            },
        } satisfies VoiceAgentHandle;

        await expect(streamVoiceAgentTurn({
            sessionId: 'sys_voice',
            handle,
            userText: 'status',
            displayUserText: 'status',
        })).rejects.toThrow('voice_output_sequence_invalid');
    });

    it('reports stream lifecycle callbacks around a completed streamed turn', async () => {
        const order: string[] = [];
        const onUserTranscriptAccepted = vi.fn(async () => {
            order.push('accepted');
        });
        const onStreamStarted = vi.fn(async (_streamId: string) => {});
        const onStreamFinished = vi.fn(async () => {});
        const startTurnStream = vi.fn(async () => ({ streamId: 'stream-1' }));
        const readTurnStream = vi.fn(async () => {
            order.push('read');
            return {
                streamId: 'stream-1',
                events: [{ t: 'done' as const, assistantText: 'ok', actions: [] }],
                nextCursor: 1,
                done: true,
            };
        });

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
                options: { onUserTranscriptAccepted },
                onStreamStarted,
                onStreamFinished,
            }),
        ).resolves.toEqual({ assistantText: 'ok', actions: [] });

        expect(startTurnStream).toHaveBeenCalledTimes(1);
        expect(onUserTranscriptAccepted).toHaveBeenCalledTimes(1);
        expect(readTurnStream).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['accepted', 'read']);
        expect(onStreamStarted).toHaveBeenCalledWith('stream-1');
        expect(onStreamFinished).toHaveBeenCalledTimes(1);
    });

    it('does not settle a durable user turn or read output before daemon stream admission resolves', async () => {
        const order: string[] = [];
        let admitStream!: (started: Readonly<{ streamId: string }>) => void;
        const startTurnStream = vi.fn(() => new Promise<Readonly<{ streamId: string }>>((resolve) => {
            admitStream = resolve;
        }));
        const onUserTranscriptAccepted = vi.fn(async () => {
            order.push('accepted');
        });
        const readTurnStream = vi.fn(async () => {
            order.push('read');
            return {
                streamId: 'stream-admitted',
                events: [{ t: 'done' as const, assistantText: 'ok', actions: [] }],
                nextCursor: 1,
                done: true,
            };
        });
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

        const turn = streamVoiceAgentTurn({
            sessionId: 'sys_voice',
            handle,
            userText: 'wait for admission',
            displayUserText: 'wait for admission',
            options: { onUserTranscriptAccepted },
        });

        await vi.waitFor(() => {
            expect(startTurnStream).toHaveBeenCalledTimes(1);
        });
        expect(onUserTranscriptAccepted).not.toHaveBeenCalled();
        expect(readTurnStream).not.toHaveBeenCalled();

        admitStream({ streamId: 'stream-admitted' });

        await expect(turn).resolves.toEqual({ assistantText: 'ok', actions: [] });
        expect(order).toEqual(['accepted', 'read']);
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
