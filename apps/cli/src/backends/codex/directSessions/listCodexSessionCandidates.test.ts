import { mkdir, mkdtemp, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCodexAgentRuntimeDescriptorV1 } from '@happier-dev/protocol';

import { listCodexSessionCandidates } from './listCodexSessionCandidates';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'response_item', payload })}\n`;
}

function makeDirectSessionsEnv(codexHome: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: codexHome,
    HAPPIER_CODEX_APP_SERVER_BIN: join(codexHome, 'missing-codex-app-server-binary'),
    ...overrides,
  } as NodeJS.ProcessEnv;
}

async function writeFakeCodexAppServerScript(params: Readonly<{
  dir: string;
  nonArchivedThreads?: Array<Record<string, unknown>>;
  archivedThreads?: Array<Record<string, unknown>>;
  allowedCodexHomes?: string[];
}>): Promise<string> {
  const scriptPath = join(params.dir, 'fake-codex-app-server.mjs');
  const script = [
    '#!/usr/bin/env node',
    'import readline from "node:readline";',
    `const nonArchivedThreads = ${JSON.stringify(params.nonArchivedThreads ?? [])};`,
    `const archivedThreads = ${JSON.stringify(params.archivedThreads ?? [])};`,
    `const allowedCodexHomes = ${JSON.stringify(params.allowedCodexHomes ?? null)};`,
    'if (Array.isArray(allowedCodexHomes) && !allowedCodexHomes.includes(process.env.CODEX_HOME ?? "")) {',
    '  process.stderr.write("unexpected CODEX_HOME\\n");',
    '  process.exit(1);',
    '}',
    'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'for await (const line of rl) {',
    '  if (!line.trim()) continue;',
    '  const msg = JSON.parse(line);',
    '  if (msg.method === "initialize") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "initialized") continue;',
    '  if (msg.method === "thread/list") {',
    '    const archived = msg.params?.archived === true;',
    '    const data = archived ? archivedThreads : nonArchivedThreads;',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data, nextCursor: null } }) + "\\n");',
    '    continue;',
    '  }',
    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
    '}',
  ].join('\n');
  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  return scriptPath;
}

describe('listCodexSessionCandidates', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unmock('node:fs/promises');
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
      env: makeDirectSessionsEnv(codexHome),
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
      env: makeDirectSessionsEnv(codexHome),
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

  it('does not read rollout metadata for sessions outside the requested page when no search term is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-page-only-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const newestSessionId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const middleSessionId = 'bbbbbbbb-1111-1111-1111-111111111111';
    const oldestSessionId = 'cccccccc-1111-1111-1111-111111111111';

    const newest = join(sessionsDir, `rollout-2026-01-03T00-00-00-${newestSessionId}.jsonl`);
    const middle = join(sessionsDir, `rollout-2026-01-02T00-00-00-${middleSessionId}.jsonl`);
    const oldest = join(sessionsDir, `rollout-2026-01-01T00-00-00-${oldestSessionId}.jsonl`);

    await writeFile(newest, sessionMetaLine({ id: newestSessionId, timestamp: '2026-01-03T00:00:00.000Z', cwd: '/repo/newest' }), 'utf8');
    await writeFile(middle, sessionMetaLine({ id: middleSessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/middle' }), 'utf8');
    await writeFile(oldest, sessionMetaLine({ id: oldestSessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/oldest' }), 'utf8');

    await utimes(newest, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));
    await utimes(middle, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));
    await utimes(oldest, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));

    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        open: async (filePath: Parameters<typeof actual.open>[0], ...args: Parameters<typeof actual.open> extends [any, ...infer Rest] ? Rest : never) => {
          if (String(filePath).includes(oldestSessionId)) {
            throw new Error('sentinel rollout metadata should not be opened for first-page listing');
          }
          return actual.open(filePath, ...args);
        },
      };
    });

    const { listCodexSessionCandidates: listWithMockedFs } = await import('./listCodexSessionCandidates');

    const first = await listWithMockedFs({
      source: { kind: 'codexHome', home: 'user' },
      env: makeDirectSessionsEnv(codexHome),
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
      env: makeDirectSessionsEnv(codexHome),
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
      env: makeDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
      searchTerm: 'aaaa',
    });
    expect(bySessionId.candidates.length).toBe(1);
    expect(bySessionId.candidates[0]?.remoteSessionId).toBe(session1);

    // Search by cwd substring
    const byCwd = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: makeDirectSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
      searchTerm: 'frontend',
    });
    expect(byCwd.candidates.length).toBe(1);
    expect(byCwd.candidates[0]?.remoteSessionId).toBe(session1);
    expect(byCwd.candidates[0]?.details?.cwd).toBe('/workspace/frontend');
  });

  it('prefers rollout-backed listing even when app-server thread listing is available', async () => {
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
    const fakeAppServer = await writeFakeCodexAppServerScript({
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
      env: makeDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: sessionId,
        title: 'Rollout title',
        archived: false,
        details: expect.objectContaining({
          cwd: '/repo/from-rollout',
        }),
      }),
    ]);
    expect(result.nextCursor).toBeNull();
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

    const fakeAppServer = await writeFakeCodexAppServerScript({
      dir: root,
      nonArchivedThreads: [],
      archivedThreads: [],
    });

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: makeDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
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
    const fakeAppServer = await writeFakeCodexAppServerScript({
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
      env: makeDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
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
      env: makeDirectSessionsEnv(codexHome),
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
      env: makeDirectSessionsEnv(codexHome),
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

    const fakeAppServer = await writeFakeCodexAppServerScript({
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
      env: {
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        CODEX_HOME: firstHome,
      } as NodeJS.ProcessEnv,
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
    const fakeAppServer = await writeFakeCodexAppServerScript({
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
      env: makeDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 1,
    });
    expect(first.candidates).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: makeDirectSessionsEnv(codexHome, { HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer }),
      activeServerDir: join(root, 'servers', 'cloud'),
      cursor: first.nextCursor ?? undefined,
      limit: 1,
    });

    expect(second.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
      first.candidates[0]?.remoteSessionId === rolloutSessionId ? appServerSessionId : rolloutSessionId,
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('disposes timed-out app-server listing subprocesses instead of leaking them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-timeout-dispose-'));
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    const pidFile = join(root, 'pid.txt');
    const fakeAppServer = join(root, 'fake-codex-app-server-timeout.mjs');
    const script = [
      '#!/usr/bin/env node',
      'import { writeFile } from "node:fs/promises";',
      'import readline from "node:readline";',
      `const pidFile = ${JSON.stringify(pidFile)};`,
      'await writeFile(pidFile, String(process.pid), "utf8");',
      'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
      'for await (const line of rl) {',
      '  if (!line.trim()) continue;',
      '  const msg = JSON.parse(line);',
      '  if (msg.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n");',
      '    continue;',
      '  }',
      '  if (msg.method === "initialized") continue;',
      '  if (msg.method === "thread/list") { await new Promise(() => {}); }',
      '}',
    ].join('\n');
    await writeFile(fakeAppServer, script, { encoding: 'utf8', mode: 0o755 });

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: makeDirectSessionsEnv(codexHome, {
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        HAPPIER_CODEX_DIRECT_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '100',
      }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates).toEqual([]);

    const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
