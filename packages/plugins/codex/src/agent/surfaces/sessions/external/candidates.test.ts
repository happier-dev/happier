import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

import { listCodexSessionCandidates } from './candidateSource.js';
import {
  createInitialCodexExternalSessionIndexCursor,
  decodeCodexExternalSessionCandidateCursor,
  decodeCodexExternalSessionIndexCursor,
  encodeCodexExternalSessionCandidateCursor,
  encodeCodexExternalSessionIndexCursor,
  resolveCodexExternalSessionAppServerListBudgetMs,
} from './candidates.js';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

// `fast` must select the bounded rollout path without invoking app-server I/O.
const fastModeExec = {} as ExecService;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex external-session candidate helpers', () => {
  it('round-trips generation-fenced candidate scan cursors', () => {
    const boundary = {
      sourceGeneration: 'source-generation',
      containerKey: '000000:2:2026/07/23',
      fileName: 'rollout-2026-07-23T10-00-00-session.jsonl',
      scanned: 1_250,
    };

    expect(
      decodeCodexExternalSessionCandidateCursor(encodeCodexExternalSessionCandidateCursor(boundary)),
    ).toEqual(boundary);
    expect(decodeCodexExternalSessionCandidateCursor('not-a-cursor')).toBeNull();
  });

  it.each([
    ['v2 traversal position without scan progress', {
      v: 2,
      kind: 'codexRolloutCandidatePage',
      sourceGeneration: 'source-generation',
      containerKey: '000000:2:2026/07/23',
      fileName: 'rollout-2026-07-23T10-00-00-session.jsonl',
    }],
    ['v3 last-activity ordering key', {
      v: 3,
      kind: 'codexRolloutCandidatePage',
      sourceGeneration: 'source-generation',
      updatedAtMs: 1_753_257_600_123,
      remoteSessionId: '11111111-1111-1111-1111-111111111111',
    }],
  ])('rejects the superseded %s cursor', (_label, cursor) => {
    // Neither superseded cursor names a position in the bounded scan the host
    // candidate index drives. Rejecting them routes the surface through its
    // existing source-changed refresh instead of silently resuming from a
    // meaningless position.
    expect(decodeCodexExternalSessionCandidateCursor(
      Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url'),
    )).toBeNull();
  });

  it('round-trips strict native continuation state and rejects prior numeric cursors', () => {
    const cursor = encodeCodexExternalSessionIndexCursor({
      ...createInitialCodexExternalSessionIndexCursor(),
      rolloutOffset: 42,
      active: { cursor: 'active-next', previousCursor: null, offset: 3, done: false },
      archived: { cursor: null, previousCursor: 'archived-prior', offset: 0, done: false },
    });

    expect(decodeCodexExternalSessionIndexCursor(cursor)).toEqual({
      v: 5,
      kind: 'codexMergedCandidatePage',
      rolloutOffset: 42,
      active: { cursor: 'active-next', previousCursor: null, offset: 3, done: false },
      archived: { cursor: null, previousCursor: 'archived-prior', offset: 0, done: false },
    });
    expect(decodeCodexExternalSessionIndexCursor('')).toBeNull();
    expect(decodeCodexExternalSessionIndexCursor('not-base64-json')).toBeNull();
    expect(
      decodeCodexExternalSessionIndexCursor(
        Buffer.from(JSON.stringify({ v: 1, kind: 'index', offset: -7 }), 'utf8').toString('base64url'),
      ),
    ).toBeNull();
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

      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: fastModeExec,
        limit: 10,
        searchMode: 'fast',
      } as const;

      // Unsearched browse is the host candidate index's bounded build. Its rows
      // carry preparation progress AND the title, because the chunk head-reads
      // only the rows it returns — the whole-corpus work the chunked build
      // exists to avoid is reading every SCANNED rollout, not every served one.
      const browse = await listCodexSessionCandidates(request);
      expect(browse.preparation).toEqual({ kind: 'building_candidate_index', scanned: 1 });
      expect(browse.candidates).toHaveLength(1);
      expect(browse.candidates[0]).toMatchObject({
        remoteSessionId,
        activity: 'unknown',
        title: expectedTitle,
      });

      // The exact-id search route hydrates the same row through the same title
      // owner, so a served row cannot change its title by route; hydration adds
      // the cwd the chunk does not read.
      const page = await listCodexSessionCandidates({ ...request, searchTerm: remoteSessionId });

      expect(page.preparation).toBeUndefined();
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
