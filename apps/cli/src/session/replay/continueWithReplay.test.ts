import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

const readCredentials = vi.hoisted(() => vi.fn());
const fetchSessionByIdCompat = vi.hoisted(() => vi.fn());
const getOrCreateSessionByTag = vi.hoisted(() => vi.fn());
const fetchSessionById = vi.hoisted(() => vi.fn());
const fetchEncryptedTranscriptMessagesPage = vi.hoisted(() => vi.fn());
const spawnDaemonSession = vi.hoisted(() => vi.fn());
const archiveSessionByIdBestEffort = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readCredentials,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat,
  getOrCreateSessionByTag,
  fetchSessionById,
}));

vi.mock('@/session/replay/fetchEncryptedTranscriptMessages', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/replay/fetchEncryptedTranscriptMessages')>(),
  fetchEncryptedTranscriptMessagesPage,
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlClient')>(),
  spawnDaemonSession,
}));

vi.mock('@/session/services/setSessionArchivedState', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/services/setSessionArchivedState')>(),
  archiveSessionByIdBestEffort,
}));

import { continueSessionWithReplay } from './continueWithReplay';

const SOURCE_SESSION_SEQ = 3;

function primeSourceTranscript(): void {
  fetchSessionByIdCompat.mockResolvedValue({
    id: 'sess_prev',
    seq: SOURCE_SESSION_SEQ,
    createdAt: 1,
    updatedAt: 2,
    active: true,
    activeAt: 2,
    encryptionMode: 'plain',
    metadata: JSON.stringify({ path: '/repo', flavor: 'claude' }),
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
  });
  fetchEncryptedTranscriptMessagesPage.mockResolvedValue({ hasMore: false, nextBeforeSeq: null, nextAfterSeq: null, messages: [
    {
      seq: 1,
      createdAt: 1,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'first question' } } },
    },
    {
      seq: 2,
      createdAt: 2,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'first answer' } } },
    },
    {
      seq: 3,
      createdAt: 3,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'latest question' } } },
    },
  ] });
}

/**
 * What `POST /v1/sessions` actually answers with: the row carrying the exact
 * creation metadata this call just posted, lineage envelopes included. The
 * creator authenticates the returned row against the requested source recipe, so
 * a fixture that dropped those envelopes would be testing a shape the server
 * never produces.
 */
function createdChildRow(): Record<string, unknown> {
  return {
    id: 'sess_child',
    seq: 0,
    createdAt: 10,
    updatedAt: 10,
    active: false,
    activeAt: 0,
    encryptionMode: 'plain',
    metadata: JSON.stringify({
      path: '/repo',
      flavor: 'claude',
      forkV1: {
        v: 1,
        parentSessionId: 'sess_prev',
        parentCutoffSeqInclusive: SOURCE_SESSION_SEQ,
        strategy: 'replay',
      },
      replaySeedV1: {
        v: 1,
        seedText: 'seed text',
        sourceSessionId: 'sess_prev',
        sourceCutoffSeqInclusive: SOURCE_SESSION_SEQ,
      },
    }),
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
  };
}

describe('continueSessionWithReplay — canonical creation delegation', () => {
  beforeEach(() => {
    readCredentials.mockReset();
    fetchSessionByIdCompat.mockReset();
    getOrCreateSessionByTag.mockReset();
    fetchSessionById.mockReset();
    fetchEncryptedTranscriptMessagesPage.mockReset();
    spawnDaemonSession.mockReset();
    archiveSessionByIdBestEffort.mockClear();
    readCredentials.mockResolvedValue({
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
    });
    primeSourceTranscript();
    getOrCreateSessionByTag.mockResolvedValue({ session: createdChildRow() });
  });

  it('creates the child through the canonical creator with its own retry identity', async () => {
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as SpawnSessionResult));

    const result = await continueSessionWithReplay(
      {
        directory: '/repo',
        agentId: 'claude',
        approvedNewDirectoryCreation: true,
        replay: { previousSessionId: 'sess_prev', strategy: 'recent_messages', recentMessagesCount: 3 },
      },
      { spawnSession },
    );

    expect(result).toMatchObject({ type: 'success', sessionId: 'sess_child' });

    // Exactly one row creator, reached with this ingress's preserved tag shape.
    expect(getOrCreateSessionByTag).toHaveBeenCalledTimes(1);
    const creation = getOrCreateSessionByTag.mock.calls[0]![0] as {
      tag: string;
      metadata: Record<string, unknown>;
    };
    expect(creation.tag).toMatch(
      new RegExp(`^replay:sess_prev:${SOURCE_SESSION_SEQ}:[0-9a-f-]{36}$`),
    );
    expect(creation.metadata).toMatchObject({
      tag: creation.tag,
      flavor: 'claude',
      forkV1: {
        v: 1,
        parentSessionId: 'sess_prev',
        parentCutoffSeqInclusive: SOURCE_SESSION_SEQ,
        strategy: 'replay',
        providerHint: { providerId: 'claude' },
      },
      replaySeedV1: {
        v: 1,
        sourceSessionId: 'sess_prev',
        sourceCutoffSeqInclusive: SOURCE_SESSION_SEQ,
      },
    });
    expect(creation.metadata).not.toHaveProperty('sessionMediaContinuityV1');
    expect(String((creation.metadata.replaySeedV1 as { seedText?: unknown }).seedText ?? ''))
      .toContain('latest question');

    // In-daemon ingress: the launch goes through the injected handler, never the
    // control client, and attaches to the row this creation committed.
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      approvedNewDirectoryCreation: true,
      existingSessionId: 'sess_child',
    }));
    expect(spawnDaemonSession).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  it('returns the launch envelope unchanged without archiving an ambiguously admitted child', async () => {
    const spawnFailure = {
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'spawn failed',
    } as SpawnSessionResult;
    const spawnSession = vi.fn(async () => spawnFailure);

    const result = await continueSessionWithReplay(
      {
        directory: '/repo',
        agentId: 'claude',
        replay: { previousSessionId: 'sess_prev' },
      },
      { spawnSession },
    );

    expect(result).toEqual(spawnFailure);
    expect(archiveSessionByIdBestEffort).not.toHaveBeenCalled();
  });

  it('creates no child when the source transcript carries no dialog', async () => {
    // A SUCCESSFUL page fetch that returns no rows. A Replay-seeded spawn still
    // has no reason to exist, but the refusal now names the real reason: the
    // hydrator distinguishes "read it, there is nothing" from "could not read
    // it", so this path must not claim a hydration failure that did not happen.
    fetchEncryptedTranscriptMessagesPage.mockResolvedValue({ messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
    const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'sess_child' } as SpawnSessionResult));

    const result = await continueSessionWithReplay(
      { directory: '/repo', agentId: 'claude', replay: { previousSessionId: 'sess_prev' } },
      { spawnSession },
    );

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Replay seed draft is empty',
    });
    expect(getOrCreateSessionByTag).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });
});
