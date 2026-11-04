import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_OUTPUT_INCOMPLETE_TEXT, SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, createSessionFixture } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
    readVoiceAgentActionEffectId,
    type VoiceAgentAcceptedOutputV1,
    type VoiceAgentHandle,
} from './types';

const network = await installSessionOpsNetworkBoundary();
let home: Awaited<ReturnType<typeof network.addHome>>;
await loadSyncSingletonForTests();
const { streamVoiceAgentTurn } = await import('./streamVoiceAgentTurn');
const { DaemonVoiceAgentClient } = await import('./daemonVoiceAgentClient');

// Replies come from the external daemon. Scoped Account admission, Session crypto,
// response decoding, output sequencing/redaction and transcript custody stay real.
function serveVoiceStream(reply: Readonly<{
    start: () => Promise<unknown>;
    read: () => Promise<unknown>;
    cancel: () => Promise<unknown>;
}>) {
    network.setRpcResponder(async request => {
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START) return reply.start();
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) return reply.read();
        if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) return reply.cancel();
        throw new Error(`Unexpected Voice stream RPC: ${request.method}`);
    });
    return new DaemonVoiceAgentClient({ serverId: home.id, accountId: home.accountId });
}

beforeEach(async () => {
    network.resetRequests();
    home = await network.addHome('https://voice-stream-output.example.test', 'account-a');
    network.setHttpResponder(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path !== '/v2/sessions/sys_voice') return null;
        const session = createSessionFixture({ id: 'sys_voice', serverId: home.id, active: true });
        return Response.json({ session: SessionCurrentProjectionRecordV1Schema.parse({
            ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata),
            effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
            responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
            agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
        }) });
    });
});
afterAll(() => network.dispose());

describe('streamVoiceAgentTurn', () => {
    it('carries a delivered instruction receipt through the daemon strict reader once per stream', async () => {
        const receipt = { serverId: home.id, sessionId: 'target' };
        const receipts: unknown[] = [];
        let reads = 0;
        const client = serveVoiceStream({ start: async () => ({ streamId: 'receipt-stream' }),
            read: async () => ({ streamId: 'receipt-stream', preparedInstructionsFor: receipt,
                events: ++reads === 1 ? [{ t: 'delta', textDelta: 'ready' }] : [{ t: 'done', assistantText: 'ready' }],
                nextCursor: reads, done: reads === 2 }), cancel: async () => ({ ok: true }) });
        await streamVoiceAgentTurn({ sessionId: 'sys_voice', handle: { client, voiceAgentId: 'run', rpcSessionId: 'sys_voice' },
            userText: 'hello', displayUserText: 'hello', options: { onPreparedInstructionsFor: fact => { receipts.push(fact); } } });
        expect(receipts).toEqual([receipt]);
    });
    it.each(['identity', 'stream'] as const)('refuses an invalid receipt %s before publishing instructions', async invalid => {
        const receipts: unknown[] = [];
        const client = serveVoiceStream({ start: async () => ({ streamId: 'receipt-stream' }),
            read: async () => ({ streamId: invalid === 'stream' ? 'superseded-stream' : 'receipt-stream',
                preparedInstructionsFor: { serverId: home.id, sessionId: 'target', ...(invalid === 'identity' ? { extra: true } : {}) },
                events: [], nextCursor: 0, done: true }), cancel: async () => ({ ok: true }) });
        await expect(streamVoiceAgentTurn({ sessionId: 'sys_voice', handle: { client, voiceAgentId: 'run', rpcSessionId: 'sys_voice' },
            userText: 'hello', displayUserText: 'hello', options: { onPreparedInstructionsFor: fact => { receipts.push(fact); } } }))
            .rejects.toThrow('invalid_rpc_response');
        expect(receipts).toEqual([]);
    });
    it('cancels an unanswered stream admission and permits a fresh turn', async () => {
        const caller = new AbortController();
        let entered!: () => void;
        const admitted = new Promise<void>(resolve => { entered = resolve; });
        let first = true;
        const client = serveVoiceStream({
            start: async () => {
                if (first) { first = false; entered(); return await new Promise(() => {}); }
                return { streamId: 'retry-stream' };
            },
            read: async () => ({ streamId: 'retry-stream', events: [{ t: 'done', assistantText: 'ready' }], nextCursor: 1, done: true }),
            cancel: async () => ({ ok: true }),
        });
        const handle = { client, voiceAgentId: 'run_1', rpcSessionId: 'sys_voice' };
        let outcome = 'pending';
        const pending = streamVoiceAgentTurn({ sessionId: 'sys_voice', handle, userText: 'hello',
            displayUserText: 'hello', options: { signal: caller.signal } })
            .then(() => { outcome = 'resolved'; }, () => { outcome = 'cancelled'; });
        await admitted;
        caller.abort();
        await pending;
        expect(outcome).toBe('cancelled');
        await expect(streamVoiceAgentTurn({ sessionId: 'sys_voice', handle, userText: 'again', displayUserText: 'again' }))
            .resolves.toMatchObject({ assistantText: 'ready' });
    });
    it('returns the useful incomplete predecessor reply through the real consumer without cancelling it', async () => {
        const text = '你好🙂'.repeat(25_000);
        const accepted: VoiceAgentAcceptedOutputV1[] = [];
        const handle = {
            transcriptEpoch: 0,
            backend: 'daemon', rpcSessionId: 'sys_voice', voiceAgentId: 'run_1', agentBackendId: 'claude',
            client: serveVoiceStream({
                start: vi.fn(async () => ({ streamId: 'stream-incomplete' })),
                read: vi.fn(async () => ({
                    streamId: 'stream-incomplete',
                    events: [
                        { t: 'delta' as const, textDelta: text },
                        { t: 'done' as const, assistantText: text, actions: [{ t: 'teleportVoiceAgentToSessionRoot', args: { sessionId: 's1' } }] },
                    ],
                    nextCursor: 2, done: true,
                })),
                cancel: vi.fn(async () => ({ ok: true as const })),
            }),
        } satisfies Omit<VoiceAgentHandle, 'accountLifetime' | 'metadataSessionId'>;
        const result = await streamVoiceAgentTurn({
            sessionId: 'sys_voice', handle, userText: 'hello', displayUserText: 'hello',
            options: { onOutputEvent: (output) => { accepted.push(output); } },
        });
        const spoken = accepted.flatMap((output) => output.effects).filter((effect) => effect.kind === 'speak').map((effect) => effect.text).join('');
        expect(result.assistantText.startsWith(spoken)).toBe(true);
        expect(result.assistantText.endsWith(VOICE_OUTPUT_INCOMPLETE_TEXT)).toBe(true);
        expect(result.actions).toEqual([{ t: 'teleportVoiceAgentToSessionRoot', args: { sessionId: 's1' } }]);
        expect(accepted.at(-1)?.effects).toEqual([{ kind: 'persist_final', text: result.assistantText }]);
        expect(network.requests.some(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL)).toBe(false);
    });

    it('projects the legacy daemon wire through the single canonical output-event boundary', async () => {
        const onOutputEvent = vi.fn(async (_output: VoiceAgentAcceptedOutputV1) => {});
        const handle = {
            transcriptEpoch: 0,
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: serveVoiceStream({
                start: vi.fn(async () => ({ streamId: 'stream-1' })),
                read: vi.fn(async () => ({
                    streamId: 'stream-1',
                    events: [
                        { t: 'delta' as const, textDelta: 'Hello ' },
                        { t: 'done' as const, assistantText: 'Hello world', actions: [{ t: 'sendSessionMessage', args: { message: 'Do it' } }] },
                    ],
                    nextCursor: 2,
                    done: true,
                })),
                cancel: vi.fn(async () => ({ ok: true as const })),
            }),
        } satisfies Omit<VoiceAgentHandle, 'accountLifetime' | 'metadataSessionId'>;

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
            transcriptEpoch: 0,
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: serveVoiceStream({
                start: vi.fn(async () => ({ streamId: 'stream-replay' })),
                read: vi.fn(async () => ({
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
                cancel: vi.fn(async () => ({ ok: true as const })),
            }),
        } satisfies Omit<VoiceAgentHandle, 'accountLifetime' | 'metadataSessionId'>;

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

    it('delivers all wire-valid status output beyond the retired payload quota with display redaction', async () => {
        const onOutputEvent = vi.fn(async (_output: VoiceAgentAcceptedOutputV1) => {});
        const events = [...Array.from({ length: 240 }, (_, seq) => ({
            t: 'voice_output' as const,
            output: {
                v: 1 as const,
                kind: 'display_status' as const,
                turnId: 'stream-budget',
                seq,
                statusId: `status-${seq}`,
                text: `/Users/a/${'x'.repeat(1_015)}`,
            },
        })), { t: 'voice_output' as const, output: { v: 1 as const, kind: 'turn_final' as const,
            turnId: 'stream-budget', seq: 240, text: 'Complete.' } }];
        const handle = {
            transcriptEpoch: 0,
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: serveVoiceStream({
                start: vi.fn(async () => ({ streamId: 'stream-budget' })),
                read: vi.fn(async () => ({
                    streamId: 'stream-budget',
                    events,
                    nextCursor: events.length,
                    done: true,
                })),
                cancel: vi.fn(async () => ({ ok: true as const })),
            }),
        } satisfies Omit<VoiceAgentHandle, 'accountLifetime' | 'metadataSessionId'>;

        await expect(streamVoiceAgentTurn({
            sessionId: 'sys_voice',
            handle,
            userText: 'status',
            displayUserText: 'status',
            options: { onOutputEvent },
        })).resolves.toMatchObject({ assistantText: 'Complete.' });
        expect(onOutputEvent).toHaveBeenCalledTimes(events.length);
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
            transcriptEpoch: 0,
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: serveVoiceStream({
                start: vi.fn(async () => ({ streamId: 'stream-order' })),
                read: vi.fn(async () => ({
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
                cancel: vi.fn(async () => ({ ok: true as const })),
            }),
        } satisfies Omit<VoiceAgentHandle, 'accountLifetime' | 'metadataSessionId'>;

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
            transcriptEpoch: 0,
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: serveVoiceStream({
                start: startTurnStream,
                read: readTurnStream,
                cancel: vi.fn(async () => ({ ok: true as const })),
            }),
        } satisfies Omit<VoiceAgentHandle, 'accountLifetime' | 'metadataSessionId'>;

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
        const admissionEntered = createDeferred<void>();
        let admitStream!: (started: Readonly<{ streamId: string }>) => void;
        const startTurnStream = vi.fn(() => new Promise<Readonly<{ streamId: string }>>((resolve) => {
            admitStream = resolve;
            admissionEntered.resolve();
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
            transcriptEpoch: 0,
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: serveVoiceStream({
                start: startTurnStream,
                read: readTurnStream,
                cancel: vi.fn(async () => ({ ok: true as const })),
            }),
        } satisfies Omit<VoiceAgentHandle, 'accountLifetime' | 'metadataSessionId'>;

        const turn = streamVoiceAgentTurn({
            sessionId: 'sys_voice',
            handle,
            userText: 'wait for admission',
            displayUserText: 'wait for admission',
            options: { onUserTranscriptAccepted },
        });

        await admissionEntered.promise;
        expect(startTurnStream).toHaveBeenCalledTimes(1);
        expect(onUserTranscriptAccepted).not.toHaveBeenCalled();
        expect(readTurnStream).not.toHaveBeenCalled();

        admitStream({ streamId: 'stream-admitted' });

        await expect(turn).resolves.toEqual({ assistantText: 'ok', actions: [] });
        expect(order).toEqual(['accepted', 'read']);
    });

    it('surfaces a daemon terminal cancellation instead of returning an empty successful turn', async () => {
        const cancelTurnStream = vi.fn(async () => ({ ok: true as const }));
        const handle = {
            transcriptEpoch: 0,
            backend: 'daemon',
            rpcSessionId: 'sys_voice',
            voiceAgentId: 'run_1',
            agentBackendId: 'claude',
            client: serveVoiceStream({
                start: vi.fn(async () => ({ streamId: 'stream-cancelled' })),
                read: vi.fn(async () => ({
                    streamId: 'stream-cancelled',
                    events: [{ t: 'cancelled' as const }],
                    nextCursor: 1,
                    done: true,
                })),
                cancel: cancelTurnStream,
            }),
        } satisfies Omit<VoiceAgentHandle, 'accountLifetime' | 'metadataSessionId'>;

        await expect(streamVoiceAgentTurn({
            sessionId: 'sys_voice',
            handle,
            userText: 'cancel me',
            displayUserText: 'cancel me',
        })).rejects.toMatchObject({ message: 'stream_cancelled', rpcErrorCode: 'cancelled' });
        expect(cancelTurnStream).not.toHaveBeenCalled();
    });
});
