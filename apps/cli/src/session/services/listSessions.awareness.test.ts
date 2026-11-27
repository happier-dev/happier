import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAwarenessListResultV1Schema, parseSessionListQueryActionResultV1 } from '@happier-dev/protocol';

import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture, createSessionNotificationContextFixture, createSessionRuntimeManagedSubtreeRecordFixture, createCompactSessionListRowFixture, createCompactSessionListQueryResponseFixture, createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createSessionListActionDeps } from '@/session/actions/sessionListActionDependency';
import { listSessions } from './listSessions';
import { createRestrictedCurrentSessionListActionDependency } from '@/session/actions/sessionListActionDependency';
import { encrypt, encodeBase64 } from '@/api/encryption';

describe('Session awareness Action acquisition', () => {
  it('keeps encrypted workers unreadable with the coordinator key and retains the server continuation', async () => {
    const key = new Uint8Array(32).fill(7);
    const fullWorker = createSessionRuntimeManagedSubtreeRecordFixture({ id: 'encrypted-worker', encryptionMode: 'e2ee',
      metadata: encodeBase64(encrypt(key, 'dataKey', { v: 1, summary: { text: 'Must not open with the coordinator key' } })) });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (String(url).endsWith('/v2/sessions/read-batch')) {
        expect(body).toMatchObject({ underSessionId: 'coordinator' });
        return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: [fullWorker] }) };
      }
      return { status: 200, data: { sessions: [createCompactSessionListRowFixture(fullWorker)], nextCursor: 'next-worker', hasNext: true,
        attentionNextCursor: null, attentionHasNext: false } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('Restricted listing must not read Account state'); });
    const sessionList = createRestrictedCurrentSessionListActionDependency({ credentials: { token: 'runtime-token', encryption: null },
      sessionId: 'coordinator', serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
      material: { mode: 'e2ee', dataEncryptionKey: key } });
    await expect(sessionList({ context: { surface: 'agent', authority: 'account_automation',
      defaultSessionId: 'coordinator', sessionListAccess: 'current_session' }, view: 'awareness',
      query: { v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
        audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, underSessionId: 'coordinator' } }))
      .resolves.toMatchObject({ sessions: [{ sessionId: 'encrypted-worker', encryption: 'unknown' }],
        nextCursor: 'next-worker', hasNext: true, view: 'awareness', projectionVersion: 1 });
  });
  it('uses the Home subtree query for Under-self even when the credentialed host admits a current-Session corpus', async () => {
    const worker = { ...createSessionNotificationContextFixture('worker'), encryptionMode: 'plain' as const, metadata: '{}' };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      throw new Error(`Unexpected detail/Account read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => ({ status: 200, data:
      String(url).endsWith('/v2/sessions/read-batch')
        ? createSessionReadBatchResponseFixture({ request: body, sessions: [worker] })
        : createCompactSessionListQueryResponseFixture({ sessions: [worker], nextCursor: null, hasNext: false,
          attentionNextCursor: null, attentionHasNext: false }) }));
    const { sessionList } = createSessionListActionDeps({ credentials: { token: 'token', encryption: null } });
    await expect(sessionList({ context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 'coordinator',
      sessionListAccess: 'current_session' }, query: { v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible',
        attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, underSessionId: 'coordinator' } }))
      .resolves.toMatchObject({ sessions: [{ id: 'worker' }], queryVersion: 1 });
  });
  beforeEach(() => {
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
    resetInMemoryAccountSettingsContextForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetInMemoryAccountSettingsContextForTests();
  });

  it.each(['summary', 'awareness'] as const)('preserves metadata omissions in an exhausted %s Action page', async (view) => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (path === '/v2/sessions') {
        return { status: 200, data: {
          sessions: [], nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 1,
        } };
      }
      throw new Error(`Unexpected HTTP request: ${path}`);
    });
    const { sessionList: list } = createSessionListActionDeps({ credentials: { token: 'token', encryption: null } });
    const result = await list({
      context: { surface: 'cli', authority: 'present_user' }, view, includeSystem: true,
    });

    expect(result).toMatchObject({
      sessions: [], nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 1,
    });
    if (view === 'awareness') expect(SessionAwarenessListResultV1Schema.parse(result)).toEqual(result);
  });

  it.each(['summary', 'awareness'] as const)('retains metadata omissions when refilling a %s page with readable rows', async (view) => {
    const row = createSessionRecordFixture({ id: 'readable-session', encryptionMode: 'plain', metadata: '{}' });
    const cursors: Array<string | null> = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      if (parsed.pathname === '/v2/sessions') {
        const cursor = parsed.searchParams.get('cursor');
        cursors.push(cursor);
        if (cursor === null) return { status: 200, data: {
          sessions: [], nextCursor: 'cursor_v1_omitted', hasNext: true, metadataUpgradeRequiredCount: 2,
        } };
        if (cursor === 'cursor_v1_omitted') return { status: 200, data: {
          sessions: [], nextCursor: 'cursor_v1_readable', hasNext: true, metadataUpgradeRequiredCount: 1,
        } };
        if (cursor === 'cursor_v1_readable') return { status: 200, data: {
          sessions: [createCompactSessionListRowFixture(row)], nextCursor: null, hasNext: false,
        } };
      }
      throw new Error(`Unexpected HTTP request: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => ({ status: 200,
      data: createSessionReadBatchResponseFixture({ request: body, sessions: [row] }) }));
    const result = await listSessions({
      credentials: { token: 'token', encryption: null }, view,
      activeOnly: false, includeSystem: false, resumableOnly: false, limit: 1,
    });

    // Counts cover omissions across consumed pages, not unique missing Sessions.
    expect(result).toMatchObject({ nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 3 });
    expect(result.sessions).toHaveLength(1);
    expect(cursors).toEqual([null, 'cursor_v1_omitted', 'cursor_v1_readable']);
    if (view === 'awareness') expect(SessionAwarenessListResultV1Schema.parse(result)).toEqual(result);
  });

  it.each(['summary', 'awareness'] as const)('preserves metadata omissions alongside strict-query continuation in %s output', async (view) => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      }
      throw new Error(`Unexpected GET request: ${path}`);
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: {
      sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: 'cursor_v1_attention', attentionHasNext: true, metadataUpgradeRequiredCount: 1,
    } });
    const result = await listSessions({
      credentials: { token: 'token', encryption: null }, view, includeSystem: true, resumableOnly: false,
      query: {
        v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any',
        audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, includeAttention: true,
      },
    });

    expect(result).toMatchObject({
      sessions: [], nextCursor: null, hasNext: false,
      attentionNextCursor: 'cursor_v1_attention', attentionHasNext: true, metadataUpgradeRequiredCount: 1,
    });
    expect(view === 'awareness'
      ? SessionAwarenessListResultV1Schema.parse(result)
      : parseSessionListQueryActionResultV1(result)).toEqual(result);
  });

  it('projects a marked page from actual V2 rows without requesting transcript content', async () => {
    const nowMs = Date.now();
    const row = createSessionRecordFixture({
      id: 'sess-working', encryptionMode: 'plain',
      metadata: JSON.stringify({ summary: { text: 'Working session' } }),
      active: true, activeAt: nowMs, latestTurnStatus: 'in_progress',
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
    });
    const requests: string[] = [];
    // HTTP is the only substituted boundary; settings, row normalization and projection are real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }) };
      }
      if (path === '/v2/sessions') {
        return { status: 200, data: {
          sessions: [createCompactSessionListRowFixture(row)], nextCursor: 'cursor-next', hasNext: true,
          attentionNextCursor: 'attention-next', attentionHasNext: true,
        } };
      }
      throw new Error(`Unexpected HTTP request: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      requests.push(new URL(String(url)).pathname);
      return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: [row] }) };
    });
    const { sessionList: list } = createSessionListActionDeps({ credentials: { token: 'token', encryption: null } });
    const result = await list({
      context: { surface: 'cli', authority: 'present_user' },
      view: 'awareness',
      includeSystem: true,
    });

    expect(result).toMatchObject({
      view: 'awareness', projectionVersion: 1,
      sessions: [{ sessionId: row.id, title: 'Working session', lifecycle: 'active',
        operational: { primary: 'working' }, encryption: 'plain' }],
      nextCursor: 'cursor-next', hasNext: true,
    });
    expect(result).not.toHaveProperty('attentionNextCursor');
    expect(result).not.toHaveProperty('attentionHasNext');
    expect(result).not.toHaveProperty('queryVersion');
    expect(requests.sort()).toEqual(['/v1/account/encryption/currentness', '/v2/sessions', '/v2/sessions/read-batch']);
  });

  it('preserves strict-query attention continuation in the awareness contract', async () => {
    const row = createSessionRecordFixture({ id: 'sess-query', encryptionMode: 'plain', metadata: '{}' });
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }) };
      }
      throw new Error(`Unexpected GET request: ${path}`);
    });
    const fullRow = {
        ...row,
        effectiveAccess: {
          v: 1,
          level: 'owner',
          sources: [{ kind: 'owner' }],
          capabilities: {
            readTranscript: true,
            submitAgentInput: true,
            editSessionRecords: true,
            approveRuntimePermissions: true,
            manageAccess: true,
            managePermissionDelegation: true,
            managePublicLink: true,
            archiveSession: true,
            renameSession: true,
            assignResponsibility: true,
            stopSession: true,
            deleteSession: true,
          },
        },
        viewer: {
          latestFailureSeq: null,
          readState: { state: 'not_started' },
          relevance: { relevant: true, reasons: ['owned_by_me'] },
          attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
          follow: { follows: false, notificationLevel: null },
          notification: { level: 'important', source: 'owner' },
        },
        responsibleAccountId: null,
        responsibleAccount: null,
      } satisfies Parameters<typeof createCompactSessionListRowFixture>[0];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => ({ status: 200, data:
      String(url).endsWith('/v2/sessions/read-batch')
        ? createSessionReadBatchResponseFixture({ request: body, sessions: [fullRow] })
        : createCompactSessionListQueryResponseFixture({ sessions: [fullRow], nextCursor: null, hasNext: false,
          attentionNextCursor: 'cursor_v1_attention', attentionHasNext: true }) }));

    const result = await listSessions({
      credentials: { token: 'token', encryption: null }, includeSystem: true, resumableOnly: false,
      view: 'awareness',
      query: {
        v: 1, storage: 'active', includeInactive: false, scope: 'my_work', attention: 'needs_my_attention',
        audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, includeAttention: true,
      },
    });

    expect(result).toEqual(expect.objectContaining({
      view: 'awareness',
      nextCursor: null, hasNext: false,
      attentionNextCursor: 'cursor_v1_attention', attentionHasNext: true,
    }));
    expect(result).not.toHaveProperty('queryVersion');
  });

  it('rejects a routing-profile mismatch before issuing Home requests', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: createAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }),
    });
    const { sessionList: list } = createSessionListActionDeps({
      credentials: { token: 'token', encryption: null },
      serverId: 'home-profile-routing-id',
    });

    const result = await list({
      context: { serverId: 'tampered-routing-id' },
      view: 'awareness',
      includeSystem: true,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'server_target_mismatch',
      error: 'server_target_mismatch',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('carries the served Account recipient readiness into each projected row', async () => {
    // An E2EE row whose data-key envelope has not been delivered to this Account yet. The row
    // alone cannot tell "waiting for access" from "we did not look"; only the Account currentness
    // the service already fetches can, so this fails if the caller drops that evidence.
    const row = createSessionRecordFixture({
      id: 'sess-awaiting-access', encryptionMode: 'e2ee', metadata: 'retained-ciphertext',
      dataEncryptionKey: null, share: { accessLevel: 'view', canApprovePermissions: false },
      active: true, activeAt: Date.now(),
      pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
    } as never);
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({
          mode: 'e2ee', recipientEnvelopeReadiness: { status: 'available' },
        }) };
      }
      if (path === '/v2/sessions') return { status: 200, data: { sessions: [createCompactSessionListRowFixture(row)], nextCursor: null, hasNext: false } };
      throw new Error(`Unexpected HTTP request: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => ({ status: 200,
      data: createSessionReadBatchResponseFixture({ request: body, sessions: [row] }) }));

    const { sessionList: list } = createSessionListActionDeps({ credentials: { token: 'token', encryption: null } });
    const result = await list({
      context: { surface: 'cli', authority: 'present_user' },
      view: 'awareness',
      includeSystem: true,
    });

    expect(result).toMatchObject({
      sessions: [{ sessionId: row.id, encryption: 'access_pending', availability: 'locked' }],
    });
  });

  it('bounds explicit preview reads and preserves the page when an individual preview fails', async () => {
    const rows = Array.from({ length: 9 }, (_, index) => createSessionRecordFixture({
      id: `c${String(index).padStart(24, "0")}`, encryptionMode: 'plain', metadata: '{}',
    }));
    let inFlight = 0;
    let peak = 0;
    let previews = 0;
    const previewQueries: URLSearchParams[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      const parsedUrl = new URL(String(url));
      const path = parsedUrl.pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({ version: 1, updatedAt: 1 }) };
      }
      if (path === '/v2/sessions') return { status: 200, data: { sessions: rows.map(createCompactSessionListRowFixture), nextCursor: null, hasNext: false } };
      const row = rows.find((entry) => path === `/v2/sessions/${entry.id}`);
      if (row) return { status: 200, data: { session: row } };
      if (path.endsWith('/messages')) {
        previews += 1;
        previewQueries.push(parsedUrl.searchParams);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        if (path.includes(`${rows[0]!.id}/`)) throw new Error('Preview unavailable');
        return { status: 200, data: { messages: [], hasMore: false } };
      }
      throw new Error(`Unexpected HTTP request: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => ({ status: 200,
      data: createSessionReadBatchResponseFixture({ request: body, sessions: rows }) }));
    const result = await listSessions({
      credentials: { token: 'token', encryption: null }, includeSystem: true, resumableOnly: false,
      includeLastMessagePreview: true,
    });
    expect(previews).toBe(rows.length);
    expect(peak).toBeLessThanOrEqual(4);
    for (const query of previewQueries) {
      expect(Object.fromEntries(query)).toEqual({ limit: '1', scope: 'main', roles: 'user,agent' });
    }
    expect(result.sessions.map((session) => session.id)).toEqual(rows.map((row) => row.id));
  });
});
