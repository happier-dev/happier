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

function historyMutation(sessionId: string, localId: string, createdAt = 1_000, updatedAt = 1_500) {
  return {
    v: 1 as const,
    sessionId,
    mutationId: `transcript:${sessionId}:${localId}`,
    source: 'transcript_message_append' as const,
    localId,
    messageRole: 'agent' as const,
    content: {
      t: 'plain' as const,
      v: { role: 'agent' as const, content: { type: 'text' as const, text: `output ${localId}` } },
    },
    createdAt,
    updatedAt,
    provenance: { kind: 'non_dependent' as const, source: 'history' as const },
  };
}

describe('session durable transcript mutation provenance', () => {
  beforeAll(async () => {
    tempHomeDir = await mkdtemp(join(tmpdir(), 'happier-dev-transcript-provenance-'));
    process.env.HAPPIER_HOME_DIR = tempHomeDir;
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
    process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
    vi.resetModules();
  });

  beforeEach(async () => {
    const { default: axios } = await import('axios');
    vi.mocked(axios.post).mockReset();
    vi.mocked(axios.post).mockResolvedValue({ data: { ok: true } });
  });

  afterEach(async () => {
    const { resetSessionClientDurableMutationOutboxStateForTests } = await import('./createSessionClientDurableMutationOutbox');
    await resetSessionClientDurableMutationOutboxStateForTests();
  });

  afterAll(async () => {
    restoreEnv('HAPPIER_HOME_DIR', originalHappyHomeDir);
    restoreEnv('HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS', originalBaseRetryMs);
    restoreEnv('HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS', originalJitterMs);
    await rm(tempHomeDir, { recursive: true, force: true });
  });

  it('rejects a new mutation without explicit schema-valid provenance before custody', async () => {
    const { createTranscriptMessageAppendMutation } = await import('./sessionClientDurableMutationTypes');
    expect(() => createTranscriptMessageAppendMutation({
      sessionId: 'missing-provenance',
      localId: 'assistant-1',
      content: 'ciphertext',
      createdAt: 100,
    } as Parameters<typeof createTranscriptMessageAppendMutation>[0])).toThrow(
      'Transcript append mutation provenance is required',
    );

    const { createRuntimeSessionClientDurableMutationOutbox } = await import('./createRuntimeSessionClientDurableMutationOutbox');
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'token',
      sessionId: 'missing-provenance',
      initiallyActive: false,
      flushOnReady: false,
      getSocket: () => createApiSessionSocketStub({ connected: false }),
      requestReconnect: () => {},
    });
    await expect(outbox.enqueueTranscriptMessage({
      ...historyMutation('missing-provenance', 'assistant-1'),
      provenance: undefined,
    } as unknown as Parameters<typeof outbox.enqueueTranscriptMessage>[0])).rejects.toThrow(
      'Transcript append mutation provenance is required',
    );
    await expect(readQueued('missing-provenance')).resolves.toEqual([]);
    await outbox.close();
  });

  it('keeps a public-dev provenance-free journal row diagnosable while causing zero transport effect', async () => {
    const sessionId = 'legacy-journal-row';
    const legacyPayload = { ...historyMutation(sessionId, 'assistant-1') } as Record<string, unknown>;
    delete legacyPayload.provenance;
    const { saveSessionClientDurableMutationOutbox } = await import('./sessionClientDurableMutationPersistence');
    await saveSessionClientDurableMutationOutbox(sessionId, [{
      kind: 'transcript_message_append',
      mutationId: `transcript:${sessionId}:assistant-1`,
      payload: legacyPayload,
      createdAt: 2_000,
      attempts: 0,
      nextAttemptAt: 0,
    } as Parameters<typeof saveSessionClientDurableMutationOutbox>[1][number]]);

    const events: string[] = [];
    const socket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event) => {
        events.push(event);
        return { ok: true, id: 'ordinary-message', seq: 1, localId: 'assistant-1' };
      },
    });
    const { createRuntimeSessionClientDurableMutationOutbox } = await import('./createRuntimeSessionClientDurableMutationOutbox');
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'token',
      sessionId,
      flushOnReady: false,
      getSocket: () => socket,
      requestReconnect: () => {},
    });
    await outbox.awaitReady();
    await outbox.flush('flush');

    const { default: axios } = await import('axios');
    expect(events).toEqual([]);
    expect(axios.post).not.toHaveBeenCalled();
    await expect(readQueued(sessionId)).resolves.toEqual([
      expect.objectContaining({
        kind: 'transcript_message_append',
        mutationId: `transcript:${sessionId}:assistant-1`,
        payload: expect.not.objectContaining({ provenance: expect.anything() }),
      }),
    ]);
    await outbox.close();
  });

  it('preserves exact chronology and non-live provenance across restart and observation-only delivery', async () => {
    const sessionId = 'long-outage-restart';
    const { createRuntimeSessionClientDurableMutationOutbox } = await import('./createRuntimeSessionClientDurableMutationOutbox');
    const disconnected = createRuntimeSessionClientDurableMutationOutbox({
      token: 'token',
      sessionId,
      initiallyActive: false,
      flushOnReady: false,
      getSocket: () => createApiSessionSocketStub({ connected: false }),
      requestReconnect: () => {},
    });
    await disconnected.enqueueTranscriptMessage(historyMutation(sessionId, 'assistant-1', 123, 456));
    await expect(readQueued(sessionId)).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          createdAt: 123,
          updatedAt: 456,
          provenance: { kind: 'non_dependent', source: 'history' },
        }),
      }),
    ]);
    await disconnected.close();

    const events: Array<{ event: string; payload: unknown }> = [];
    const restartedSocket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        events.push({ event, payload });
        if (event === SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1) {
          return { ok: true, capability: 'session-transcript-observation-v1' };
        }
        return {
          ok: true,
          status: 'observed',
          id: 'message-1',
          seq: 1,
          localId: 'assistant-1',
          didWrite: true,
          ingestedAt: 9_999,
        };
      },
    });
    const restarted = createRuntimeSessionClientDurableMutationOutbox({
      token: 'token',
      sessionId,
      flushOnReady: false,
      getSocket: () => restartedSocket,
      requestReconnect: () => {},
    });
    await restarted.awaitReady();
    await restarted.flush('flush');

    expect(events.map(({ event }) => event)).toEqual([
      SESSION_TRANSCRIPT_OBSERVATION_CAPABILITY_EVENT_V1,
      SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1,
    ]);
    expect(events[1]?.payload).toMatchObject({
      createdAt: 123,
      updatedAt: 456,
      provenance: { kind: 'non_dependent', source: 'history' },
    });
    const { default: axios } = await import('axios');
    expect(axios.post).not.toHaveBeenCalled();
    await expect(readQueued(sessionId)).resolves.toEqual([]);
    await restarted.close();
  });

  it('never coalesces one localId across different provenance', async () => {
    const sessionId = 'provenance-conflict';
    const { createRuntimeSessionClientDurableMutationOutbox } = await import('./createRuntimeSessionClientDurableMutationOutbox');
    const outbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'token',
      sessionId,
      initiallyActive: false,
      flushOnReady: false,
      getSocket: () => createApiSessionSocketStub({ connected: false }),
      requestReconnect: () => {},
    });
    await outbox.enqueueTranscriptMessage({
      ...historyMutation(sessionId, 'assistant-1'),
      provenance: { kind: 'non_dependent', source: 'external' },
    });
    await expect(outbox.enqueueTranscriptMessage(historyMutation(sessionId, 'assistant-1'))).rejects.toThrow(
      'Cannot coalesce transcript snapshot across different causal provenance',
    );
    await expect(readQueued(sessionId)).resolves.toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          provenance: { kind: 'non_dependent', source: 'external' },
        }),
      }),
    ]);
    await outbox.close();
  });
});
