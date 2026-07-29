import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { listCodexSessionCandidates } from './candidateSource.js';
import {
  decodeCodexExternalSessionCandidateCursor,
  decodeCodexExternalSessionIndexCursor,
  encodeCodexExternalSessionCandidateCursor,
  encodeCodexExternalSessionIndexCursor,
  resolveCodexExternalSessionAppServerListBudgetMs,
} from './candidates.js';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex external-session candidate helpers', () => {
  it('round-trips generation-fenced candidate continuation cursors', () => {
    const cursor = encodeCodexExternalSessionCandidateCursor({
      sourceGeneration: 'source-generation',
      containerKey: '000000:2:2026/07/23',
      fileName: 'rollout-2026-07-23T10-00-00-session.jsonl',
    });

    expect(decodeCodexExternalSessionCandidateCursor(cursor)).toEqual({
      sourceGeneration: 'source-generation',
      containerKey: '000000:2:2026/07/23',
      fileName: 'rollout-2026-07-23T10-00-00-session.jsonl',
    });
    expect(decodeCodexExternalSessionCandidateCursor('not-a-cursor')).toBeNull();
  });

  it('round-trips candidate index cursors and clamps invalid offsets', () => {
    const cursor = encodeCodexExternalSessionIndexCursor(42.8);

    expect(decodeCodexExternalSessionIndexCursor(cursor)).toBe(42);
    expect(decodeCodexExternalSessionIndexCursor('')).toBe(0);
    expect(decodeCodexExternalSessionIndexCursor('not-base64-json')).toBe(0);
    expect(
      decodeCodexExternalSessionIndexCursor(
        Buffer.from(JSON.stringify({ v: 1, kind: 'index', offset: -7 }), 'utf8').toString('base64url'),
      ),
    ).toBe(0);
  });

  it('resolves app-server listing budget from Codex external-session env', () => {
    expect(resolveCodexExternalSessionAppServerListBudgetMs({})).toBe(3_000);
    expect(resolveCodexExternalSessionAppServerListBudgetMs({
      HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '1250',
    })).toBe(1250);
    expect(resolveCodexExternalSessionAppServerListBudgetMs({
      HAPPIER_CODEX_EXTERNAL_SESSIONS_APP_SERVER_LIST_TIMEOUT_MS: '-1',
    })).toBe(3_000);
  });

  it.each([
    ['session_title_set', 'Plain Alias Codex Title'],
    ['mcp__happy__session_title_set', 'MCP Alias Codex Title'],
  ])('hydrates rollout-backed titles directly from the %s alias', async (toolName, expectedTitle) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-24T00:00:00.000Z'));
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-external-title-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });
      const remoteSessionId = toolName.startsWith('mcp__')
        ? '33333333-3333-3333-3333-333333333333'
        : '22222222-2222-2222-2222-222222222222';
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T08-28-05-${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T08:28:05.000Z',
            payload: {
              id: remoteSessionId,
              timestamp: '2026-07-23T08:28:05.000Z',
              cwd: '/repo/codex',
            },
          }),
          jsonl({
            type: 'response_item',
            timestamp: '2026-07-23T08:28:30.000Z',
            payload: {
              type: 'function_call',
              call_id: `title-call-${remoteSessionId}`,
              name: toolName,
              arguments: JSON.stringify({ title: expectedTitle }),
            },
          }),
        ].join(''),
        'utf8',
      );

      const page = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        limit: 10,
        searchMode: 'fast',
      });

      expect(page.candidates).toHaveLength(1);
      expect(page.candidates[0]).toMatchObject({
        remoteSessionId,
        title: expectedTitle,
        activity: 'unknown',
        details: {
          cwd: '/repo/codex',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
