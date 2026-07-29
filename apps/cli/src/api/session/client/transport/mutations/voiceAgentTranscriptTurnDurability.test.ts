import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
    SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
} from '@happier-dev/protocol';

import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;
const originalBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
const originalJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
let tempHomeDir = '';

vi.mock('axios');

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

async function readQueued(sessionId: string): Promise<unknown[]> {
    const { resolveSessionClientDurableMutationOutboxPath } = await import('./sessionClientDurableMutationPersistence');
    try {
        const parsed = JSON.parse(await readFile(resolveSessionClientDurableMutationOutboxPath(sessionId), 'utf8')) as {
            mutations?: unknown[];
        };
        return parsed.mutations ?? [];
    } catch {
        return [];
    }
}

describe('voice-agent transcript turn durability', () => {
    beforeAll(async () => {
        tempHomeDir = await mkdtemp(join(tmpdir(), 'happier-voice-turn-outbox-'));
        process.env.HAPPIER_HOME_DIR = tempHomeDir;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        vi.resetModules();
    });

    beforeEach(async () => {
        const { default: axios } = await import('axios');
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.post).mockRejectedValue(new Error('server offline'));
    });

    afterEach(async () => {
        const { resetSessionClientDurableMutationOutboxStateForTests } = await import('./createSessionClientDurableMutationOutbox');
        await resetSessionClientDurableMutationOutboxStateForTests();
    });

    afterAll(async () => {
        restoreEnv('HAPPIER_HOME_DIR', originalHappyHomeDir);
        restoreEnv('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', originalBaseRetryMs);
        restoreEnv('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', originalJitterMs);
        await rm(tempHomeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it('retains one authoritative pair after a partial ack and replays both stable roles after restart', async () => {
        const {
            createTranscriptMessageAppendMutation,
            createVoiceAgentTranscriptTurnMutation,
        } = await import('./sessionClientDurableMutationTypes');
        const { createRuntimeSessionClientDurableMutationOutbox } = await import('./createRuntimeSessionClientDurableMutationOutbox');
        const sessionId = 'voice-session-1';
        const turnId = 'stream-voice-turn-1';
        const user = createTranscriptMessageAppendMutation({
            sessionId,
            localId: `${turnId}:user`,
            content: { t: 'plain', v: { role: 'user', content: { id: 'u', type: 'text', text: 'voice user' } } },
            messageRole: 'user',
            createdAt: 100,
            provenance: { kind: 'non_dependent', source: 'sidechain' },
        });
        const assistant = createTranscriptMessageAppendMutation({
            sessionId,
            localId: `${turnId}:assistant`,
            content: { t: 'plain', v: { role: 'agent', content: { id: 'a', type: 'message', data: { type: 'message', message: 'voice assistant' } } } },
            messageRole: 'agent',
            createdAt: 200,
            provenance: { kind: 'non_dependent', source: 'sidechain' },
        });
        const mutation = createVoiceAgentTranscriptTurnMutation({ sessionId, turnId, user, assistant });
        const delivered: string[] = [];
        let rejectAssistant = true;
        const firstSocket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: async (event, payload) => {
                if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                    return { ok: true, capability: 'session-transcript-observation-v1' };
                }
                if (event !== SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) return { ok: false };
                const localId = String((payload as { localId?: unknown }).localId ?? '');
                expect(payload).toMatchObject({
                    provenance: { kind: 'non_dependent', source: 'sidechain' },
                });
                delivered.push(localId);
                if (rejectAssistant && localId === assistant.localId) return { ok: false };
                return {
                    ok: true,
                    status: 'observed',
                    id: `message-${localId}`,
                    seq: delivered.length,
                    localId,
                    didWrite: true,
                    ingestedAt: 300,
                };
            },
        });
        const first = createRuntimeSessionClientDurableMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => firstSocket,
            requestReconnect: () => {},
        });

        await expect(first.enqueueVoiceAgentTranscriptTurn(mutation)).resolves.toEqual({
            persisted: true,
            delivered: false,
        });
        await expect.poll(() => readQueued(sessionId)).toEqual([
            expect.objectContaining({
                kind: 'voice_agent_transcript_turn',
                mutationId: mutation.mutationId,
            }),
        ]);

        firstSocket.connected = true;
        await first.flush('connect');
        expect(delivered).toEqual([user.localId, assistant.localId]);
        await expect.poll(() => readQueued(sessionId)).toHaveLength(1);

        // Model process loss after the first role ACK: keep the durable record,
        // then instantiate a fresh outbox owner over the same persisted file.
        firstSocket.connected = false;
        await first.close();
        rejectAssistant = false;
        delivered.length = 0;
        const restartedSocket = createApiSessionSocketStub({
            connected: true,
            emitWithAck: async (event, payload) => {
                if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
                    return { ok: true, capability: 'session-transcript-observation-v1' };
                }
                if (event !== SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) return { ok: false };
                const localId = String((payload as { localId?: unknown }).localId ?? '');
                expect(payload).toMatchObject({
                    provenance: { kind: 'non_dependent', source: 'sidechain' },
                });
                delivered.push(localId);
                return {
                    ok: true,
                    status: 'observed',
                    id: `message-${localId}`,
                    seq: delivered.length,
                    localId,
                    didWrite: true,
                    ingestedAt: 400,
                };
            },
        });
        const restarted = createRuntimeSessionClientDurableMutationOutbox({
            token: 'tok',
            sessionId,
            getSocket: () => restartedSocket,
            requestReconnect: () => {},
        });

        await expect.poll(() => delivered).toEqual([user.localId, assistant.localId]);
        await expect.poll(() => readQueued(sessionId)).toEqual([]);
        await restarted.close();
    });
});
