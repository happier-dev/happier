import { createServer } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ForkSpawnSession } from './forkLifecycleTypes';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { withCliApiToken } from '@/auth/cliApiToken';
import { createForkSessionLifecycleActionHandler } from '../createForkSessionLifecycleActionHandler';
import { SessionInitialAccessServerError, SessionTeamCredentialBindingRejectedError } from '@/api/session/sessionCreationInitialAccess';

// Home HTTP and account-encryption reads are the system boundary here; the
// Fork lifecycle, its inheritance owner and the canonical Session creator run for real.
const getOrCreateSessionByTagMock = vi.fn();
const fetchSessionByIdCompatMock = vi.fn();
const resolveReplaySeedDraftMock = vi.fn();
const fetchSessionOrganizationPlacementMock = vi.fn();
const validateStoredAuthTokenAgainstActiveServerMock = vi.fn();
const fetchAccountEncryptionCurrentnessMock = vi.fn();

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: (...args: unknown[]) =>
    resolveReplaySeedDraftMock(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/session/transport/http/sessionsHttp')
  >()),
  getOrCreateSessionByTag: (...args: unknown[]) =>
    getOrCreateSessionByTagMock(...args),
  fetchSessionByIdCompat: (...args: unknown[]) =>
    fetchSessionByIdCompatMock(...args),
  fetchSessionOrganizationPlacement: (...args: unknown[]) =>
    fetchSessionOrganizationPlacementMock(...args),
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (...args: unknown[]) =>
    validateStoredAuthTokenAgainstActiveServerMock(...args),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: (...args: unknown[]) =>
    fetchAccountEncryptionCurrentnessMock(...args),
}));

const BROKERED_TEAM_MODEL = {
  v: 1,
  slot: { kind: 'provider_model' },
  resourceId: 'team-resource-1',
  teamId: 'team-1',
  expectedResourceRevision: 0,
  deliveryMode: 'brokered',
} as const;

function parentRow(acceptedTeamCredentialBinding: unknown, primaryTeamId?: string | null) {
  return {
    id: 'parent-session',
    seq: 3,
    encryptionMode: 'plain',
    metadata: JSON.stringify({
      flavor: 'codex',
      path: '/tmp/parent-worktree',
      machineId: 'machine-1',
    }),
    ...(acceptedTeamCredentialBinding !== undefined
      ? { acceptedTeamCredentialBinding }
      : {}),
    ...(primaryTeamId !== undefined ? { primaryTeamId } : {}),
  };
}

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v2/sessions/lookup-by-tags') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessions: [] }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/access-keys/child-session/')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ accessKey: 'fixture-key' }));
      return;
    }
    // Account settings are optional creation input; an absent answer is a valid Home reply.
    if (request.method === 'GET' && /^\/v[12]\/account\/settings$/.test(request.url ?? '')) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a loopback listener');
    return await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, run);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function forkByReplay(acceptedTeamCredentialBinding: unknown, primaryTeamId?: string | null) {
  fetchSessionByIdCompatMock.mockResolvedValueOnce(
    parentRow(acceptedTeamCredentialBinding, primaryTeamId),
  );
  const spawnSession = vi
    .fn<ForkSpawnSession>()
    .mockResolvedValue({ type: 'success', sessionId: 'child-session' });
  const handler = createForkSessionLifecycleActionHandler({
    sessionHostBridge: getSessionHostBridge(),
    resolveExecutionSurfaces: async () => ({
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    }),
    handlers: { spawnSession, stopSession: async () => false },
  });
  const result = await withHome(() => withCliApiToken(
    `hap_v1_123e4567-e89b-42d3-a456-426614174000_${'A'.repeat(43)}`,
    () =>
      handler({
        v: 1,
        parentSessionId: 'parent-session',
        forkPoint: { type: 'latest' },
        strategy: 'replay',
      }),
  ));
  return { result, spawnSession };
}

describe('Fork child credential source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrCreateSessionByTagMock.mockResolvedValue({
      session: { id: 'child-session' },
      created: true,
    });
    resolveReplaySeedDraftMock.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Replay this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 3,
      referencedSessionMediaWorkspacePaths: [],
    });
    fetchSessionOrganizationPlacementMock.mockResolvedValue({
      folderId: null,
      tagIds: [],
    });
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({
      state: 'valid',
    });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue({
      mode: 'plain',
      version: 1,
    });
  });

  it('creates the child on the Team credential its parent runs on, for Home to admit again', async () => {
    const { result, spawnSession } = await forkByReplay(BROKERED_TEAM_MODEL);

    expect(result).toEqual({ ok: true, childSessionId: 'child-session' });
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledTimes(1);
    expect(getOrCreateSessionByTagMock.mock.calls[0]?.[0]).toMatchObject({
      teamCredentialBindings: [BROKERED_TEAM_MODEL],
    });
    expect(spawnSession.mock.calls[0]?.[0]).toMatchObject({
      existingSessionId: 'child-session',
      teamCredentialBindings: [BROKERED_TEAM_MODEL],
    });
  });

  it('creates the child in its parent\'s Team context, which a team_context_required source needs', async () => {
    const { result, spawnSession } = await forkByReplay(BROKERED_TEAM_MODEL, 'team-1');

    expect(result).toEqual({ ok: true, childSessionId: 'child-session' });
    expect(getOrCreateSessionByTagMock.mock.calls[0]?.[0]).toMatchObject({
      primaryTeamId: 'team-1',
      teamCredentialBindings: [BROKERED_TEAM_MODEL],
    });
    expect(spawnSession).toHaveBeenCalledTimes(1);
  });

  it('tells the caller Home\'s exact reason, before any launch, when the share was withdrawn', async () => {
    getOrCreateSessionByTagMock.mockRejectedValueOnce(new SessionTeamCredentialBindingRejectedError('access_removed'));
    const { result, spawnSession } = await forkByReplay(BROKERED_TEAM_MODEL, 'team-1');

    expect(result).toEqual({
      ok: false,
      errorCode: 'session_team_credential_binding_rejected',
      errorMessage: expect.any(String),
      errorDetail: { kind: 'session_creation_team_credential_refused',
        code: 'session_team_credential_binding_rejected', reason: 'access_removed' },
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('tells the caller Home\'s exact reason when the person is no longer in the parent\'s Team', async () => {
    getOrCreateSessionByTagMock.mockRejectedValueOnce(new SessionInitialAccessServerError('session_access_subject_ineligible', 403));
    const { result, spawnSession } = await forkByReplay(BROKERED_TEAM_MODEL, 'team-1');

    expect(result).toMatchObject({
      ok: false,
      errorDetail: { kind: 'session_creation_access_refused', code: 'session_access_subject_ineligible' },
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('keeps a parent without a Team credential on its own sign-in', async () => {
    for (const accepted of [
      undefined,
      null,
      { v: 1, slot: { kind: 'provider_model' }, resourceId: null },
    ]) {
      getOrCreateSessionByTagMock.mockClear();
      const { result, spawnSession } = await forkByReplay(accepted, accepted === null ? null : undefined);

      expect(result).toMatchObject({ ok: true });
      expect(getOrCreateSessionByTagMock.mock.calls[0]?.[0]).not.toHaveProperty(
        'teamCredentialBindings',
      );
      expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty(
        'teamCredentialBindings',
      );
      expect(getOrCreateSessionByTagMock.mock.calls[0]?.[0]).not.toHaveProperty('primaryTeamId');
    }
  });
});
