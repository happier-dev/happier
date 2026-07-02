import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createCodexAppServerProcessEnv } from '@/backends/codex/appServer/testkit/fakeCodexAppServer';

const openProbe = vi.hoisted(() => ({
  nonMatchingSessionId: '',
  nonMatchingOpenCount: 0,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      if (openProbe.nonMatchingSessionId && String(args[0]).includes(openProbe.nonMatchingSessionId)) {
        openProbe.nonMatchingOpenCount += 1;
      }
      return actual.open(...args);
    },
  };
});

import { listCodexSessionCandidates } from './externalCandidates';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'response_item', payload })}\n`;
}

function createExternalSessionsEnv(codexHome: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return createCodexAppServerProcessEnv(
    overrides.HAPPIER_CODEX_APP_SERVER_BIN ?? join(codexHome, 'missing-codex-app-server-binary'),
    {
      CODEX_HOME: codexHome,
      ...overrides,
    },
  );
}

describe('listCodexSessionCandidates external id search', () => {
  it('matches rollout session ids without reading non-matching rollout titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-external-id-search-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const matchingSessionId = 'aaaaaaaa-1111-1111-1111-111111111111';
    const nonMatchingSessionId = 'bbbbbbbb-2222-2222-2222-222222222222';
    openProbe.nonMatchingSessionId = nonMatchingSessionId;
    openProbe.nonMatchingOpenCount = 0;

    const matchingRollout = join(sessionsDir, `rollout-2026-01-01T00-00-00-${matchingSessionId}.jsonl`);
    const nonMatchingRollout = join(sessionsDir, `rollout-2026-01-02T00-00-00-${nonMatchingSessionId}.jsonl`);
    await writeFile(
      matchingRollout,
      sessionMetaLine({ id: matchingSessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/matching' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Matching title' }] }),
      'utf8',
    );
    await writeFile(
      nonMatchingRollout,
      sessionMetaLine({ id: nonMatchingSessionId, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/non-matching' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'Non matching title' }] }),
      'utf8',
    );
    await utimes(matchingRollout, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(nonMatchingRollout, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));

    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createExternalSessionsEnv(codexHome),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
      searchTerm: matchingSessionId,
    });

    expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([matchingSessionId]);
    expect(openProbe.nonMatchingOpenCount).toBe(0);
  });

  it('bounds app-server candidate listing by startup time as well as list time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-external-app-server-startup-budget-'));
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    const fakeAppServer = join(root, 'fake-codex-app-server-slow-init.mjs');
    await writeFile(fakeAppServer, [
      '#!/usr/bin/env node',
      'import readline from "node:readline";',
      'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
      'for await (const line of rl) {',
      '  if (!line.trim()) continue;',
      '  const msg = JSON.parse(line);',
      '  if (msg.method === "initialize") {',
      '    setTimeout(() => process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake", version: "0.0.0" } } }) + "\\n"), 3000);',
      '    continue;',
      '  }',
      '  if (msg.method === "initialized") continue;',
      '  if (msg.method === "thread/list") {',
      '    process.stdout.write(JSON.stringify({ id: msg.id, result: { data: [], nextCursor: null } }) + "\\n");',
      '  }',
      '}',
    ].join('\n'), { encoding: 'utf8', mode: 0o755 });

    const startedAtMs = Date.now();
    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: createExternalSessionsEnv(codexHome, {
        HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
        HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '100',
      }),
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 10,
    });

    expect(result.candidates).toEqual([]);
    expect(result.searchIncomplete).toBe(true);
    expect(Date.now() - startedAtMs).toBeLessThan(1000);
  });
});
