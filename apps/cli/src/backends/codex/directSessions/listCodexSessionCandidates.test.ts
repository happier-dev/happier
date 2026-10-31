import { mkdir, mkdtemp, readFile, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCodexAgentRuntimeDescriptorV1 } from '@happier-dev/protocol';
import { waitForCondition } from '@/testkit/async/waitFor';
import {
  createCodexAppServerProcessEnv,
  writeFakeCodexAppServerScript,
  writeFakeCodexAppServerThreadListScript,
} from '@/backends/codex/appServer/testkit/fakeCodexAppServer';

import { listCodexSessionCandidates } from './listCodexSessionCandidates';
import { listCodexDirectSessionCandidatesViaRollouts } from './listCodexDirectSessionCandidatesViaRollouts';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'response_item', payload })}\n`;
}

function createDirectSessionsEnv(codexHome: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return createCodexAppServerProcessEnv(
    overrides.HAPPIER_CODEX_APP_SERVER_BIN ?? join(codexHome, 'missing-codex-app-server-binary'),
    {
      CODEX_HOME: codexHome,
      // Metadata assertions await the fixture; foreground-budget tests override this explicitly.
      HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '5000',
      ...overrides,
    },
  );
}

async function createMutableAppServerListing() {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-snapshot-'));
  const codexHome = join(root, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  const statePath = join(root, 'listing.json');
  await writeFile(statePath, JSON.stringify({ fail: false }));
  const fakeAppServer = await writeFakeCodexAppServerScript({
    dir: root,
    importLines: ['import { readFile } from "node:fs/promises";'],
    setupLines: [
      `const statePath = ${JSON.stringify(statePath)};`,
    ],
    bodyLines: [
      'for await (const line of rl) {',
      '  if (!line.trim()) continue;',
      '  const msg = JSON.parse(line);',
      '  if (msg.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
      '  } else if (msg.method === "thread/list") {',
      '    const state = JSON.parse(await readFile(statePath, "utf8"));',
      '    const updatedAt = Math.floor(Date.now() / 1000);',
      '    const data = msg.params.archived ? [] : [{ id: "native-only-thread", name: "Native title", createdAt: updatedAt, updatedAt }];',
      '    process.stdout.write(JSON.stringify(state.fail',
      '      ? { id: msg.id, error: { code: -32000, message: "Listing unavailable" } }',
      '      : { id: msg.id, result: { data, nextCursor: null } }) + "\\n");',
      '  }',
      '}',
    ],
  });
  const list = () => listCodexSessionCandidates({
    source: { kind: 'codexHome', home: 'user' },
    env: createDirectSessionsEnv(codexHome, {
      HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
      HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '5000',
      HAPPIER_DIRECT_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
    }),
    activeServerDir: join(root, 'servers', 'cloud'),
    limit: 10,
  });
  return { list, statePath };
}

describe('listCodexSessionCandidates', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unmock('node:fs/promises');
  });

  it('excludes Guardian rollouts before paging and searching while retaining user reviews and spawned agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-guardian-'));
    const codexHome = join(root, 'codex-home');
    const sessions = [
      { id: '11111111-1111-1111-1111-111111111111', source: 'cli', title: 'Guardian review', archived: false },
      { id: '22222222-2222-2222-2222-222222222222', source: { subagent: { thread_spawn: { parent_thread_id: 'parent', depth: 1 } } }, title: 'Coding agent', archived: false },
      { id: '33333333-3333-3333-3333-333333333333', source: { subagent: 'review' }, title: 'User review', archived: false },
      // Source vectors: openai/codex@970111f6cb62cc02fe36a82ea7d71b37a2889c97,
      // SessionSource.ts and SubAgentSource.ts (rollout spelling).
      { id: '44444444-4444-4444-4444-444444444444', source: { subagent: { other: 'guardian' } }, title: 'Renamed reviewer', archived: false },
      { id: '55555555-5555-5555-5555-555555555555', source: { subagent: { other: 'guardian' } }, title: 'Guardian review', archived: true },
    ];
    for (const [index, session] of sessions.entries()) {
      const dir = join(codexHome, session.archived ? 'archived_sessions' : 'sessions');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `rollout-2026-01-01T00-00-00-${session.id}.jsonl`);
      await writeFile(file, sessionMetaLine({ id: session.id,
        ...([sessions[0].id, sessions[3].id].includes(session.id) ? { base_instructions: { text: 'x'.repeat(96 * 1024) } } : {}),
        source: session.source,
      })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: session.title }] }));
      await utimes(file, new Date(1000 + index), new Date(1000 + index));
    }
    const params = {
      source: { kind: 'codexHome' as const, home: 'user' as const },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: createDirectSessionsEnv(codexHome),
      limit: 2,
      searchMode: 'fast' as const,
    };
    const first = await listCodexSessionCandidates(params);
    expect(first.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([sessions[2].id, sessions[1].id]);
    expect(first.nextCursor).toBeTruthy();
    const second = await listCodexSessionCandidates({ ...params, cursor: first.nextCursor ?? undefined });
    expect(second.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([sessions[0].id]);
    expect(second.nextCursor).toBeNull();
    const byId = await listCodexSessionCandidates({ ...params, searchTerm: sessions[3].id });
    expect(byId.candidates).toEqual([]);
    expect(byId.nextCursor).toBeNull();
    const byTitle = await listCodexDirectSessionCandidatesViaRollouts({ ...params, searchMode: 'full', searchTerm: 'Guardian review' });
    expect(byTitle.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([sessions[0].id]);
    expect(byTitle.totalCount).toBe(1);
  });

  it('does not reintroduce Guardian sessions when merging app-server and rollout discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-guardian-merge-'));
    const codexHome = join(root, 'codex-home');
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    const guardianId = 'aaaaaaaa-1111-1111-1111-111111111111';
    await writeFile(join(codexHome, 'sessions', `rollout-2026-01-01T00-00-00-${guardianId}.jsonl`),
      sessionMetaLine({ id: guardianId, source: { subagent: { other: 'guardian' } } }));
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      nonArchivedThreads: [
        { id: guardianId, source: { subAgent: { other: 'guardian' } }, name: 'Renamed reviewer' },
        { id: 'user-session', source: 'cli', name: 'Guardian review' },
      ],
      archivedThreads: [{ id: 'archived-guardian', source: { subAgent: { other: 'guardian' } } }],
    });
    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'servers', 'cloud'),
      env: createDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      limit: 10,
    });
    expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['user-session']);
    expect(result.nextCursor).toBeNull();
  });

  it('lists sessions from CODEX_HOME with archived flags and paging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    const archivedDir = join(codexHome, 'archived_sessions');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const session1 = '11111111-1111-1111-1111-111111111111';
    const session2 = '22222222-2222-2222-2222-222222222222';

    const s1a = join(sessionsDir, `rollout-2026-01-01T00-00-00-${session1}.jsonl`);
    const s1b = join(sessionsDir, `rollout-2026-01-02T00-00-00-${session1}.jsonl`);
    const s2 = join(archivedDir, `rollout-2026-01-03T00-00-00-${session2}.jsonl`);

    await writeFile(
      s1a,
      sessionMetaLine({ id: session1, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/one' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }),
      'utf8',
    );
    await writeFile(
      s1b,
      sessionMetaLine({ id: session1, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/one' })
        + responseItemLine({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'world' }] }),
      'utf8',
    );
    await writeFile(
      s2,
      sessionMetaLine({ id: session2, timestamp: '2026-01-03T00:00:00.000Z', cwd: '/repo/two' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'archived' }] }),
      'utf8',
    );

    await utimes(s1a, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(s1b, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));
    await utimes(s2, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));

    const first = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 1,
    });

    expect(first.candidates.length).toBe(1);
    expect(first.candidates[0]?.remoteSessionId).toBe(session2);
    expect(first.candidates[0]?.archived).toBe(true);
    expect(first.candidates[0]?.activity).toBe('idle');
    expect(first.nextCursor).toBeTruthy();

    const second = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      cursor: first.nextCursor ?? undefined,
      limit: 10,
    });

    expect(second.candidates.map((c) => c.remoteSessionId)).toEqual([session1]);
    expect(second.candidates[0]?.archived).toBe(false);
    expect(second.candidates[0]?.title).toBe('hello');
    expect(second.candidates[0]?.activity).toBe('idle');
    expect(second.nextCursor).toBeNull();
  });

  it('uses session_meta.id when a continuation rollout filename contains a composite id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-composite-rollout-id-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const threadId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const continuationId = 'bbbbbbbb-2222-2222-2222-222222222222';
    const regularRollout = join(sessionsDir, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
    const continuationRollout = join(sessionsDir, `rollout-2026-01-02T00-00-00-${threadId}_${continuationId}.jsonl`);

    await writeFile(
      regularRollout,
      sessionMetaLine({ id: threadId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/composite' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'initial' }] }),
      'utf8',
    );
    await writeFile(
      continuationRollout,
      sessionMetaLine({ id: threadId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/composite' })
        + responseItemLine({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'continued' }] }),
      'utf8',
    );
    await utimes(regularRollout, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(continuationRollout, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([threadId]);
    expect(result.candidates[0]?.details).toEqual(expect.objectContaining({ cwd: '/repo/composite' }));
  });

  it('omits a noncanonical rollout candidate when neither its filename nor metadata identifies a thread UUID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-unresolved-rollout-id-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const rollout = join(sessionsDir, 'rollout-2026-01-02T00-00-00-unresolved_suffix.jsonl');
    await writeFile(rollout, `${JSON.stringify({ type: 'response_item', payload: { type: 'message' } })}\n`, 'utf8');
    await utimes(rollout, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates).toEqual([]);
  });

  it('uses the thread UUID from a composite filename when session metadata is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-composite-rollout-no-meta-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const threadId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const continuationId = 'bbbbbbbb-2222-2222-2222-222222222222';
    const rollout = join(sessionsDir, `rollout-2026-01-02T00-00-00-${threadId}_${continuationId}.jsonl`);
    await writeFile(rollout, responseItemLine({ type: 'message', role: 'assistant' }), 'utf8');
    await utimes(rollout, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([threadId]);
  });

  it('searches metadata-resolved IDs in full mode even when another rollout filename matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-resolved-id-search-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const searchTerm = 'aaaa';
    const searchId = 'aaaa0000-1111-1111-1111-111111111111';
    const otherId = 'aaaaaaaa-2222-2222-2222-222222222222';
    const filenameMatch = join(sessionsDir, `rollout-2026-01-02T00-00-00-${otherId}.jsonl`);
    const metadataMatch = join(sessionsDir, 'rollout-2026-01-01T00-00-00-opaque-suffix.jsonl');
    await writeFile(
      filenameMatch,
      sessionMetaLine({ id: otherId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/filename-match' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'different session' }] }),
      'utf8',
    );
    await writeFile(
      metadataMatch,
      sessionMetaLine({ id: searchId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/metadata-match' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'target session' }] }),
      'utf8',
    );
    await utimes(filenameMatch, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));
    await utimes(metadataMatch, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
      searchTerm,
      searchMode: 'full',
    });

    expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(expect.arrayContaining([searchId, otherId]));
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.find((candidate) => candidate.remoteSessionId === searchId)?.details)
      .toEqual(expect.objectContaining({ cwd: '/repo/metadata-match' }));
  });

  it('reads only metadata heads for sessions outside the requested page when no search term is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-page-only-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const newestSessionId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const middleSessionId = 'bbbbbbbb-1111-1111-1111-111111111111';
    const oldestSessionId = 'cccccccc-1111-1111-1111-111111111111';
    const offPageContinuationThreadId = 'dddddddd-1111-1111-1111-111111111111';
    const offPageContinuationTurnId = 'eeeeeeee-1111-1111-1111-111111111111';

    const newest = join(sessionsDir, `rollout-2026-01-03T00-00-00-${newestSessionId}.jsonl`);
    const middle = join(sessionsDir, `rollout-2026-01-02T00-00-00-${middleSessionId}.jsonl`);
    const oldest = join(sessionsDir, `rollout-2026-01-01T00-00-00-${oldestSessionId}.jsonl`);
    const offPageContinuation = join(
      sessionsDir,
      `rollout-2025-12-31T00-00-00-${offPageContinuationThreadId}_${offPageContinuationTurnId}.jsonl`,
    );

    await writeFile(newest, sessionMetaLine({ id: newestSessionId, timestamp: '2026-01-03T00:00:00.000Z', cwd: '/repo/newest' }), 'utf8');
    await writeFile(middle, sessionMetaLine({ id: middleSessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/middle' }), 'utf8');
    const largeBody = responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] });
    await writeFile(oldest, sessionMetaLine({ id: oldestSessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/oldest' }) + largeBody, 'utf8');
    await writeFile(
      offPageContinuation,
      sessionMetaLine({ id: offPageContinuationThreadId, timestamp: '2025-12-31T00:00:00.000Z', cwd: '/repo/off-page-continuation' }) + largeBody,
      'utf8',
    );

    await utimes(newest, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));
    await utimes(middle, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));
    await utimes(oldest, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(offPageContinuation, new Date('2025-12-31T00:00:00.000Z'), new Date('2025-12-31T00:00:00.000Z'));

    const offPageReads: Array<{ mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }> = [];
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await actual.open(...args);
          if ([oldestSessionId, offPageContinuationThreadId].some((id) => String(args[0]).includes(id))) {
            offPageReads.push(vi.spyOn(handle, 'read'));
          }
          return handle;
        },
      };
    });

    const { listCodexSessionCandidates: listWithMockedFs } = await import('./listCodexSessionCandidates');

    const first = await listWithMockedFs({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 1,
    });

    expect(first.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: newestSessionId,
        details: expect.objectContaining({
          cwd: '/repo/newest',
        }),
      }),
    ]);
    expect(first.nextCursor).toBeTruthy();
    // Source classification needs each head, but off-page transcript bodies must stay unread.
    // rolloutDiscovery's metadata reader consumes one 4 KiB chunk for these short headers.
    expect(offPageReads).toHaveLength(2);
    expect(offPageReads.flatMap((spy) => spy.mock.calls).every((call) => typeof call[2] === 'number' && call[2] <= 4096)).toBe(true);
  });

  it('matches search terms against surfaced session titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-title-search-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '33333333-3333-3333-3333-333333333333';
    const rollout = join(sessionsDir, `rollout-2026-01-04T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      rollout,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-04T00:00:00.000Z', cwd: '/repo/three' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Unique Title Query' }] }),
      'utf8',
    );
    await utimes(rollout, new Date('2026-01-04T00:00:00.000Z'), new Date('2026-01-04T00:00:00.000Z'));

    // Search by title-only term that does NOT appear in sessionId or cwd
    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
      searchTerm: 'unique',
    });

    // Should match because 'unique' appears in the title 'Unique Title Query'
    // but NOT in sessionId '33333333-3333-3333-3333-333333333333' or cwd '/repo/three'
    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: sessionId,
        title: 'Unique Title Query',
      }),
    ]);
    expect(result.candidates.length).toBe(1);
    expect(result.nextCursor).toBeNull();
  });

  it('matches search terms against remoteSessionId and cwd (regression test)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-regression-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const session1 = 'aaaaaaaa-1111-1111-1111-111111111111';
    const session2 = 'bbbbbbbb-2222-2222-2222-222222222222';

    const rollout1 = join(sessionsDir, `rollout-2026-01-05T00-00-00-${session1}.jsonl`);
    const rollout2 = join(sessionsDir, `rollout-2026-01-06T00-00-00-${session2}.jsonl`);

    await writeFile(
      rollout1,
      sessionMetaLine({ id: session1, timestamp: '2026-01-05T00:00:00.000Z', cwd: '/workspace/frontend' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Build UI' }] }),
      'utf8',
    );
    await writeFile(
      rollout2,
      sessionMetaLine({ id: session2, timestamp: '2026-01-06T00:00:00.000Z', cwd: '/workspace/backend' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'API work' }] }),
      'utf8',
    );

    await utimes(rollout1, new Date('2026-01-05T00:00:00.000Z'), new Date('2026-01-05T00:00:00.000Z'));
    await utimes(rollout2, new Date('2026-01-06T00:00:00.000Z'), new Date('2026-01-06T00:00:00.000Z'));

    // Search by sessionId substring
    const bySessionId = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
      searchTerm: 'aaaa',
    });
    expect(bySessionId.candidates.length).toBe(1);
    expect(bySessionId.candidates[0]?.remoteSessionId).toBe(session1);

    // Search by cwd substring
    const byCwd = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
      searchTerm: 'frontend',
    });
    expect(byCwd.candidates.length).toBe(1);
    expect(byCwd.candidates[0]?.remoteSessionId).toBe(session1);
    expect(byCwd.candidates[0]?.details?.cwd).toBe('/workspace/frontend');
  });

  it('uses the current app-server title when a rollout-backed session has been renamed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-app-server-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '99999999-9999-9999-9999-999999999999';
    const rollout = join(sessionsDir, `rollout-2026-01-06T00-00-00-${sessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-06T00:00:00.000Z', cwd: '/repo/from-rollout' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Rollout title' }] }),
      'utf8',
    );
    await utimes(rollout, new Date('2026-01-06T00:00:00.000Z'), new Date('2026-01-06T00:00:00.000Z'));
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      nonArchivedThreads: [{
        id: sessionId,
        preview: 'Thread from app-server',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1_736_000_000,
        updatedAt: 1_736_000_100,
        status: 'notLoaded',
        path: join(codexHome, 'sessions', `rollout-${sessionId}.jsonl`),
        cwd: '/repo/from-app-server',
        cliVersion: '0.0.0',
        source: 'vscode',
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: 'App-server title',
        turns: [],
      }],
    });

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: sessionId,
        title: 'App-server title',
        archived: false,
        details: expect.objectContaining({
          cwd: '/repo/from-rollout',
        }),
      }),
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('serves app-server titles that arrive after the list budget on later listings without waiting again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-app-server-late-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '99999999-9999-9999-9999-999999999998';
    const rollout = join(sessionsDir, `rollout-2026-01-06T00-00-00-${sessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-06T00:00:00.000Z', cwd: '/repo/from-rollout' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Rollout title' }] }),
      'utf8',
    );
    const requestsPath = join(root, 'requests.jsonl');
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      requestsPath,
      nonArchivedThreads: [{
        id: sessionId,
        preview: 'Thread from app-server',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1_736_000_000,
        updatedAt: 1_736_000_100,
        status: 'notLoaded',
        path: rollout,
        cwd: '/repo/from-app-server',
        cliVersion: '0.0.0',
        source: 'vscode',
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: 'App-server title',
        turns: [],
      }],
    });
    const list = () => listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome, {
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        // Starting any subprocess takes longer than this, so the first listing cannot wait for it.
        HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '1',
      }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    const [first, concurrent] = await Promise.all([list(), list()]);
    for (const listing of [first, concurrent]) {
      expect(listing.candidates.map((candidate) => candidate.title)).toEqual(['Rollout title']);
      expect(listing.searchIncomplete).toBe(true);
    }

    const countRequests = async (method: string) => {
      try {
        return (await readFile(requestsPath, 'utf8')).split('\n').filter((line) => line.includes(`"method":"${method}"`)).length;
      } catch {
        return 0;
      }
    };
    await waitForCondition(async () => (await countRequests('thread/list')) > 0, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'timed-out Codex app-server listing to keep running in the background',
    });

    let later: Awaited<ReturnType<typeof list>> | null = null;
    await waitForCondition(async () => {
      later = await list();
      return later.candidates[0]?.title === 'App-server title';
    }, {
      timeoutMs: 5_000,
      intervalMs: 25,
      label: 'background app-server titles to reach a later listing',
    });
    expect(later!.searchIncomplete).toBeUndefined();
    // Concurrent listings shared one app-server, and the fresh snapshot did not start another.
    expect(await countRequests('initialize')).toBe(1);
  });

  it('ages native-only snapshot activity using the canonical recent-activity window', async () => {
    const fixture = await createMutableAppServerListing();
    const first = await fixture.list();
    expect(first.candidates[0]?.activity).toBe('active_recently');

    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 6000);
    const later = await fixture.list();
    expect(later.candidates[0]?.activity).toBe('idle');
    expect(later.candidates[0]?.title).toBe('Native title');
  });

  it('drops a failed refresh snapshot, reports incomplete fallback, and recovers on retry', async () => {
    const fixture = await createMutableAppServerListing();
    expect((await fixture.list()).candidates[0]?.title).toBe('Native title');
    await writeFile(fixture.statePath, JSON.stringify({ fail: true }));
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 6000);

    // This call starts the refresh while returning the previous successful snapshot.
    await fixture.list();
    await waitForCondition(async () => {
      const result = await fixture.list();
      return result.candidates.length === 0 && result.searchIncomplete === true;
    }, { timeoutMs: 5000, intervalMs: 25, label: 'failed native refresh to invalidate its snapshot' });

    await writeFile(fixture.statePath, JSON.stringify({ fail: false }));
    const recovered = await fixture.list();
    expect(recovered.candidates[0]?.title).toBe('Native title');
    expect(recovered.searchIncomplete).toBeUndefined();
  });

  it('still lists rollout sessions when app-server returns an empty successful listing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-app-server-empty-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '88888888-8888-8888-8888-888888888888';
    const rollout = join(sessionsDir, `rollout-2026-01-07T00-00-00-${sessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-07T00:00:00.000Z', cwd: '/repo/fallback' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Fallback title' }] }),
      'utf8',
    );
    await utimes(rollout, new Date('2026-01-07T00:00:00.000Z'), new Date('2026-01-07T00:00:00.000Z'));

    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      nonArchivedThreads: [],
      archivedThreads: [],
    });

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: sessionId,
        title: 'Fallback title',
        details: { cwd: '/repo/fallback', source: { kind: 'codexHome', home: 'user', homePath: codexHome } },
      }),
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('surfaces app-server-only candidates when rollout files are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-app-server-stable-time-'));
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });

    const sessionId = '77777777-7777-7777-7777-777777777777';
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      nonArchivedThreads: [{
        id: sessionId,
        updatedAt: 1_736_000_100,
        cwd: '/repo/from-app-server',
        name: 'App-server title',
      }],
    });

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: sessionId,
        title: 'App-server title',
        details: expect.objectContaining({
          cwd: '/repo/from-app-server',
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        }),
      }),
    ]);
  });

  it('derives rollout fallback candidates from the earliest rollout and omits unverified app-server backend mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-rollout-fallback-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '66666666-6666-6666-6666-666666666666';
    const earliest = join(sessionsDir, `rollout-2026-01-08T00-00-00-${sessionId}.jsonl`);
    const latest = join(sessionsDir, `rollout-2026-01-09T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      earliest,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-08T00:00:00.000Z', cwd: '/repo/earliest' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Earliest title' }] }),
      'utf8',
    );
    await writeFile(
      latest,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-09T00:00:00.000Z', cwd: '/repo/latest' })
        + responseItemLine({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Latest content' }] }),
      'utf8',
    );

    await utimes(earliest, new Date('2026-01-08T00:00:00.000Z'), new Date('2026-01-08T00:00:00.000Z'));
    await utimes(latest, new Date('2026-01-09T00:00:00.000Z'), new Date('2026-01-09T00:00:00.000Z'));

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: sessionId,
        title: 'Earliest title',
        createdAtMs: Date.parse('2026-01-08T00:00:00.000Z'),
        updatedAtMs: Date.parse('2026-01-09T00:00:00.000Z'),
        details: expect.objectContaining({
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        }),
      }),
    ]);
    expect(result.candidates[0]?.details).toEqual({ cwd: '/repo/latest', source: { kind: 'codexHome', home: 'user', homePath: codexHome } });
  });

  it('uses rollout filename chronology instead of mtime when choosing earliest and latest rollout files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-rollout-chronology-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const sessionId = '33333333-3333-3333-3333-333333333333';
    const earliest = join(sessionsDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
    const latest = join(sessionsDir, `rollout-2026-01-02T00-00-00-${sessionId}.jsonl`);

    await writeFile(
      earliest,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/earliest' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Earliest title' }] }),
      'utf8',
    );
    await writeFile(
      latest,
      sessionMetaLine({ id: sessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/latest' })
        + responseItemLine({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Latest content' }] }),
      'utf8',
    );

    await utimes(earliest, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));
    await utimes(latest, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates[0]).toEqual(expect.objectContaining({
      title: 'Earliest title',
      createdAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      updatedAtMs: Date.parse('2026-01-03T00:00:00.000Z'),
      details: { cwd: '/repo/latest', source: { kind: 'codexHome', home: 'user', homePath: codexHome } },
    }));
  });

  it('lists mixed connected-service homes from rollout files regardless of app-server authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-partial-app-server-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'svc_1');
    const firstHome = join(homesRoot, 'profile-a', 'codex', 'codex-home');
    const secondHome = join(homesRoot, 'profile-b', 'codex', 'codex-home');
    await mkdir(firstHome, { recursive: true });
    await mkdir(join(secondHome, 'sessions'), { recursive: true });

    const appServerSessionId = '55555555-5555-5555-5555-555555555555';
    const rolloutSessionId = '44444444-4444-4444-4444-444444444444';
    const fallbackRollout = join(secondHome, 'sessions', `rollout-2026-01-10T00-00-00-${rolloutSessionId}.jsonl`);
    await writeFile(
      fallbackRollout,
      sessionMetaLine({ id: rolloutSessionId, timestamp: '2026-01-10T00:00:00.000Z', cwd: '/repo/fallback-home' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Fallback home title' }] }),
      'utf8',
    );
    await utimes(fallbackRollout, new Date('2026-01-10T00:00:00.000Z'), new Date('2026-01-10T00:00:00.000Z'));

    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      allowedCodexHomes: [firstHome],
      nonArchivedThreads: [{
        id: appServerSessionId,
        createdAt: 1_736_000_000,
        updatedAt: 1_736_000_100,
        cwd: '/repo/app-server-home',
        name: 'App-server title',
      }],
    });

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'svc_1' },
      env: createDirectSessionsEnv(firstHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir,
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: rolloutSessionId,
        details: {
          cwd: '/repo/fallback-home',
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'svc_1',
            connectedServiceProfileId: 'profile-b',
            homePath: secondHome,
          },
        },
      }),
      expect.objectContaining({
        remoteSessionId: appServerSessionId,
        title: 'App-server title',
        details: expect.objectContaining({
          cwd: '/repo/app-server-home',
          source: expect.objectContaining({
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'svc_1',
            connectedServiceProfileId: 'profile-a',
          }),
        }),
      }),
    ]);
  });

  it('uses an exact connected-service homePath without scanning all service profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-exact-home-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'svc_1');
    const exactHome = join(homesRoot, 'profile-b', 'codex', 'codex-home');
    await mkdir(join(exactHome, 'sessions'), { recursive: true });

    const exactSessionId = '22222222-2222-2222-2222-222222222222';
    const rollout = join(exactHome, 'sessions', `rollout-2026-01-10T00-00-00-${exactSessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: exactSessionId, timestamp: '2026-01-10T00:00:00.000Z', cwd: '/repo/exact-home' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Exact home title' }] }),
      'utf8',
    );

    const result = await listCodexSessionCandidates({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'svc_1',
        homePath: exactHome,
      },
      env: {} as NodeJS.ProcessEnv,
      activeServerDir,
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: exactSessionId,
        details: expect.objectContaining({
          cwd: '/repo/exact-home',
          source: expect.objectContaining({
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'svc_1',
            connectedServiceProfileId: 'profile-b',
          }),
        }),
      }),
    ]);
  });

  it('uses an exact connected-service materialized homePath for isolated Codex auth homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-materialized-home-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const exactHome = join(activeServerDir, 'daemon', 'connected-services', 'materialized', 'csm_session_1', 'codex', 'codex-home');
    await mkdir(join(exactHome, 'sessions'), { recursive: true });

    const exactSessionId = '33333333-3333-3333-3333-333333333333';
    const rollout = join(exactHome, 'sessions', `rollout-2026-01-10T00-00-00-${exactSessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: exactSessionId, timestamp: '2026-01-10T00:00:00.000Z', cwd: '/repo/materialized-home' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Materialized home title' }] }),
      'utf8',
    );

    const result = await listCodexSessionCandidates({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'svc_1',
        connectedServiceProfileId: 'profile-b',
        homePath: exactHome,
      },
      env: {} as NodeJS.ProcessEnv,
      activeServerDir,
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: exactSessionId,
        details: expect.objectContaining({
          cwd: '/repo/materialized-home',
          source: expect.objectContaining({
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'svc_1',
            connectedServiceProfileId: 'profile-b',
            homePath: exactHome,
          }),
        }),
      }),
    ]);
  });

  it('uses an exact connected-service materialized homePath from the daemon materialization root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-daemon-materialized-home-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const exactHome = join(root, 'daemon', 'connected-services', 'materialized', 'csm_session_1', 'codex', 'codex-home');
    await mkdir(join(exactHome, 'sessions'), { recursive: true });

    const exactSessionId = '66666666-6666-6666-6666-666666666666';
    const rollout = join(exactHome, 'sessions', `rollout-2026-01-10T00-00-00-${exactSessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: exactSessionId, timestamp: '2026-01-10T00:00:00.000Z', cwd: '/repo/daemon-materialized-home' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Daemon materialized home title' }] }),
      'utf8',
    );

    const result = await listCodexSessionCandidates({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'svc_1',
        connectedServiceProfileId: 'profile-b',
        homePath: exactHome,
      },
      env: {} as NodeJS.ProcessEnv,
      activeServerDir,
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: exactSessionId,
        details: expect.objectContaining({
          cwd: '/repo/daemon-materialized-home',
          source: expect.objectContaining({
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'svc_1',
            connectedServiceProfileId: 'profile-b',
            homePath: exactHome,
          }),
        }),
      }),
    ]);
  });

  it('rejects materialized connected-service homePath symlinks that escape the materialized root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-materialized-symlink-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const outsideHome = join(root, 'outside-codex-home');
    await mkdir(join(outsideHome, 'sessions'), { recursive: true });

    const exactHome = join(activeServerDir, 'daemon', 'connected-services', 'materialized', 'csm_session_1', 'codex', 'codex-home');
    await mkdir(join(exactHome, '..'), { recursive: true });
    await symlink(outsideHome, exactHome);

    const exactSessionId = '77777777-7777-7777-7777-777777777777';
    const rollout = join(outsideHome, 'sessions', `rollout-2026-01-10T00-00-00-${exactSessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: exactSessionId, timestamp: '2026-01-10T00:00:00.000Z', cwd: '/repo/escaped-home' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Escaped home title' }] }),
      'utf8',
    );

    const result = await listCodexSessionCandidates({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'svc_1',
        connectedServiceProfileId: 'profile-b',
        homePath: exactHome,
      },
      env: {} as NodeJS.ProcessEnv,
      activeServerDir,
      limit: 10,
    });

    expect(result.candidates).toEqual([]);
  });

  it('uses an exact connected-service group homePath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-group-home-'));
    const activeServerDir = join(root, 'servers', 'cloud');
    const exactHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'svc_1', '__groups', 'main', 'codex', 'codex-home');
    await mkdir(join(exactHome, 'sessions'), { recursive: true });

    const exactSessionId = '99999999-9999-9999-9999-999999999999';
    const rollout = join(exactHome, 'sessions', `rollout-2026-01-10T00-00-00-${exactSessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: exactSessionId, timestamp: '2026-01-10T00:00:00.000Z', cwd: '/repo/group-home' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Group home title' }] }),
      'utf8',
    );

    const result = await listCodexSessionCandidates({
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'svc_1',
        homePath: exactHome,
      },
      env: {} as NodeJS.ProcessEnv,
      activeServerDir,
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: exactSessionId,
        details: expect.objectContaining({
          cwd: '/repo/group-home',
          source: expect.objectContaining({
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId: 'svc_1',
            connectedServiceGroupId: 'main',
          }),
        }),
      }),
    ]);
  });

  it('keeps page-2 listing stable when rollout-backed and app-server-only candidates are merged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-merged-page-2-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const rolloutSessionId = '11111111-1111-1111-1111-111111111111';
    const rollout = join(sessionsDir, `rollout-2026-01-01T00-00-00-${rolloutSessionId}.jsonl`);
    await writeFile(
      rollout,
      sessionMetaLine({ id: rolloutSessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/rollout-only' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Rollout only title' }] }),
      'utf8',
    );
    await utimes(rollout, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

    const appServerSessionId = 'thread-appserver-only';
    const fakeAppServer = await writeFakeCodexAppServerThreadListScript({
      dir: root,
      nonArchivedThreads: [{
        id: appServerSessionId,
        createdAt: 1_736_000_050,
        updatedAt: 1_736_000_050,
        cwd: '/repo/app-server-only',
        name: 'App-server only title',
      }],
    });

    const first = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 1,
    });
    expect(first.candidates).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir: join(root, 'servers', 'cloud'),
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });

    expect(second.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
      first.candidates[0]?.remoteSessionId === rolloutSessionId ? appServerSessionId : rolloutSessionId,
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(['initialize', 'thread/list'])('disposes timed-out app-server listing subprocesses during %s', async (stalledMethod) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-timeout-dispose-'));
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    const readyFile = join(root, 'ready.json');
    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: root,
      importLines: ['import { rename, writeFile } from "node:fs/promises";'],
      bodyLines: [
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        `  if (msg.method === ${JSON.stringify(stalledMethod)}) {`,
        `    await writeFile(${JSON.stringify(`${readyFile}.tmp`)}, JSON.stringify({ pid: process.pid, method: msg.method }));`,
        `    await rename(${JSON.stringify(`${readyFile}.tmp`)}, ${JSON.stringify(readyFile)});`,
        '    await new Promise(() => {});',
        '  }',
        '  if (msg.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
        '  }',
        '}',
      ],
    });

    // Control only the refresh clock boundary; filesystem, protocol and process lifecycle stay real.
    const refreshTimeoutMs = 211;
    const schedule = globalThis.setTimeout;
    let expireRefresh: (() => void) | undefined;
    const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      const timer = schedule(callback, delay, ...args);
      if (delay === refreshTimeoutMs) {
        clearTimeout(timer);
        expireRefresh = () => { callback(...args); };
      }
      return timer;
    });
    let pid = Number.NaN;
    try {
      const result = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        env: createDirectSessionsEnv(codexHome, {
          HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
          HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '100',
          HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_REFRESH_TIMEOUT_MS: String(refreshTimeoutMs),
        }),
        activeServerDir: join(root, 'servers', 'cloud'),
        limit: 10,
      });
      expect(result.candidates).toEqual([]);
      await waitForCondition(async () => {
        try {
          const ready = JSON.parse(await readFile(readyFile, 'utf8'));
          pid = ready.pid;
          return Number.isSafeInteger(pid) && ready.method === stalledMethod;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      }, {
        timeoutMs: 5_000,
        intervalMs: 25,
        label: `Codex app-server to enter ${stalledMethod}`,
      });
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(expireRefresh).toBeTypeOf('function');
      expireRefresh!();
      await waitForCondition(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, {
        timeoutMs: 5_000,
        intervalMs: 25,
        label: 'timed-out Codex app-server subprocess to exit',
      });
    } finally {
      timeout.mockRestore();
      expireRefresh?.();
      // A failing lifecycle assertion must still release this fixture's subprocess.
      if (Number.isSafeInteger(pid)) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* Already exited. */ }
      }
    }
  });
});
