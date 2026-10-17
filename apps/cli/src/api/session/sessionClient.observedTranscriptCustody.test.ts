import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTranscriptObservationV1Schema } from '@happier-dev/protocol';

import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { configuration, reloadConfiguration } from '@/configuration';
import { createSessionMutationPersistenceContext, loadSessionMutationOutbox, parseQueuedSessionMutation } from './mutations/sessionMutationPersistence';
import { SessionMutationJournalAdmissionBlockedError } from './mutations/createSessionMutationOutbox';
import { ApiSessionClient } from './sessionClient';

const { io } = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io }));
vi.mock('axios');

describe('ApiSessionClient observed transcript custody', () => {
  const previousHome = process.env.HAPPIER_HOME_DIR;
  let directory: string;
  let client: ApiSessionClient | null = null;
  let recovered: boolean;
  let observed: string[];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'session-observed-custody-'));
    process.env.HAPPIER_HOME_DIR = directory;
    reloadConfiguration();
    recovered = false;
    observed = [];
    vi.mocked(axios.get).mockRejectedValue(new Error('Remote unavailable'));
    vi.mocked(axios.post).mockRejectedValue(new Error('Remote unavailable'));
    io.mockImplementation(() => createApiSessionSocketStub({
      connected: true,
      emitWithAck: (event, payload) => {
        if (event === 'ping') return { v: 1 };
        if (event === 'transcript-observation-capability-v1') {
          return { ok: true, capability: 'session-transcript-observation-v1' };
        }
        if (event === 'transcript-observation-v1') {
          const observation = SessionTranscriptObservationV1Schema.parse(payload);
          if (!recovered) return { ok: false, error: 'internal' };
          observed.push(observation.localId);
          return {
            ok: true, status: 'observed', id: observation.localId, seq: observed.length,
            localId: observation.localId, didWrite: true, ingestedAt: Date.now(),
          };
        }
        return { ok: false, error: 'internal' };
      },
    }));
    client = new ApiSessionClient('test-token', createPlainSessionFixture({ id: 'observed-custody' }));
  });

  afterEach(async () => {
    await client?.close();
    client = null;
    if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHome;
    reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['agent', 'user'] as const)('retains opted-in observed %s rows while transport is unavailable', async (role) => {
    const session = client!;
    const opts = { localId: `observed-${role}`, provenance: { kind: 'non_dependent', source: 'external' } } as const;
    const publication = role === 'agent'
      ? session.sendAgentMessageCommitted('pi', { type: 'message', message: 'Observed answer' }, opts)
      : session.sendUserTextMessageCommitted('Observed provider prompt', opts);
    await expect(publication).resolves.toBeUndefined();

    const queue = await loadSessionMutationOutbox(createSessionMutationPersistenceContext({
      activeServerDir: configuration.activeServerDir, custody: 'runtime',
      sessionId: session.sessionId, parseQueuedMutation: parseQueuedSessionMutation,
    }));
    expect(queue).toContainEqual(expect.objectContaining({
      kind: 'transcript_message_append',
      payload: expect.objectContaining({ localId: opts.localId, messageRole: role, provenance: opts.provenance }),
    }));
    expect(observed).toEqual([]);
    recovered = true;
    await session.flush();
    expect(observed).toEqual([opts.localId]);
  });

  it.each(['agent', 'user'] as const)('rejects opted-in observed %s publication when journal custody is closed', async (role) => {
    const session = client!;
    await session.close();
    client = null;
    const opts = { localId: `closed-${role}`, provenance: { kind: 'non_dependent', source: 'external' } } as const;
    const publication = role === 'agent'
      ? session.sendAgentMessageCommitted('pi', { type: 'message', message: 'Late answer' }, opts)
      : session.sendUserTextMessageCommitted('Late provider prompt', opts);
    await expect(publication).rejects.toBeInstanceOf(SessionMutationJournalAdmissionBlockedError);
  });
});
