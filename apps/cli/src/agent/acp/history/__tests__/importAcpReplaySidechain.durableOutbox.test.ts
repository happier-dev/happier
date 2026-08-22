import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 } from '@happier-dev/protocol';

const { configurationMock } = vi.hoisted(() => ({
  configurationMock: { activeServerDir: '' },
}));

vi.mock('@/configuration', () => ({ configuration: configurationMock }));

import type { AcpReplaySidechainSessionClient } from '@/agent/acp/sessionClient';
import { importAcpReplaySidechainV1 } from '../importAcpReplaySidechain';
import {
  createRuntimeSessionClientDurableMutationOutbox,
  resetSessionClientDurableMutationOutboxStateForTests,
} from '@/api/session/client/transport/mutations/createSessionClientDurableMutationOutbox';
import {
  createTranscriptMessageAppendMutation,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import {
  resolveSessionClientDurableMutationJournalPaths,
} from '@/api/session/client/transport/mutations/sessionClientDurableMutationPersistence';

async function readQueuedMutations(path: string): Promise<Array<{
  payload: { localId: string; provenance: unknown };
}>> {
  try {
    const persisted = JSON.parse(await readFile(path, 'utf8')) as {
      mutations?: Array<{ payload: { localId: string; provenance: unknown } }>;
    };
    return persisted.mutations ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

describe('ACP replay sidechain durable outbox integration', () => {
  beforeEach(async () => {
    configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-acp-replay-outbox-'));
  });

  afterEach(async () => {
    await resetSessionClientDurableMutationOutboxStateForTests();
    await rm(configurationMock.activeServerDir, { recursive: true, force: true });
  });

  it('retries disconnected replay rows after restart without duplicating stable semantic rows', async () => {
    const sessionId = 'session-replay-restart';
    const disconnectedOutbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'token',
      sessionId,
      getSocket: () => null,
      requestReconnect: () => undefined,
    });
    await disconnectedOutbox.awaitReady();

    const session: AcpReplaySidechainSessionClient = {
      async enqueueAgentMessageCommitted(_provider, body, opts) {
        return await disconnectedOutbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
          sessionId,
          localId: opts.localId,
          content: JSON.stringify({ body, meta: opts.meta }),
          sidechainId: typeof body.sidechainId === 'string' ? body.sidechainId : null,
          messageRole: 'agent',
          provenance: opts.provenance,
        }));
      },
    };
    const input = {
      session,
      provider: 'opencode' as const,
      remoteSessionId: 'remote-1',
      sidechainId: 'task-1',
      replay: [
        { type: 'message', role: 'agent', text: 'first' },
        { type: 'message', role: 'agent', text: 'second' },
      ],
    };

    await importAcpReplaySidechainV1(input);
    await importAcpReplaySidechainV1(input);

    const paths = resolveSessionClientDurableMutationJournalPaths({
      activeServerDir: configurationMock.activeServerDir,
      custody: 'runtime',
      sessionId,
    });
    const persistedBeforeRestart = await readQueuedMutations(paths.queuePath);
    expect(persistedBeforeRestart).toHaveLength(2);
    expect(persistedBeforeRestart.map((entry) => entry.payload.provenance)).toEqual([
      { kind: 'non_dependent', source: 'sidechain' },
      { kind: 'non_dependent', source: 'sidechain' },
    ]);
    await disconnectedOutbox.close();

    const deliveredLocalIds: string[] = [];
    const socket = {
      connected: true,
      emit: () => undefined,
      emitWithAck: async (event: string, payload: unknown) => {
        if (event !== SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
          throw new Error(`Unexpected socket event: ${event}`);
        }
        const localId = String((payload as { localId?: unknown }).localId ?? '');
        deliveredLocalIds.push(localId);
        return {
          ok: true,
          status: 'observed',
          id: `message-${deliveredLocalIds.length}`,
          seq: deliveredLocalIds.length,
          localId,
          didWrite: true,
          ingestedAt: 1_000 + deliveredLocalIds.length,
        };
      },
    };
    const restartedOutbox = createRuntimeSessionClientDurableMutationOutbox({
      token: 'token',
      sessionId,
      getSocket: () => socket,
      requestReconnect: () => undefined,
    });
    await restartedOutbox.awaitReady();
    await restartedOutbox.setSessionSyncPendingInputServerContract({
      mode: 'session_sync_v2_pending_input_v1',
      runtimeActivity: 'v2',
      pendingInput: 'v1',
      publisherAuthority: 'indeterminate',
      sessionConnectionEpoch: 1,
      socket,
      transcriptTransport: { mode: 'session_transcript_observation_v1' },
    });
    await restartedOutbox.flush('startup');

    expect(deliveredLocalIds).toEqual(persistedBeforeRestart.map((entry) => entry.payload.localId));
    expect(new Set(deliveredLocalIds).size).toBe(2);
    expect(await readQueuedMutations(paths.queuePath)).toEqual([]);
    await restartedOutbox.close();
  });
});
