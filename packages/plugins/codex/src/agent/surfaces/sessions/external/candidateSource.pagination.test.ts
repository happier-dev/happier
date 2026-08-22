import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

const appServerProbe = vi.hoisted(() => ({
  threads: [] as { id: string; updatedAt: number; cwd?: string }[],
}));

// The Codex native app-server is a spawned provider process reached over JSON-RPC:
// a genuine system boundary. Everything below it — merge ordering, cursor
// arithmetic, rollout discovery — stays the real implementation.
vi.mock('../../../runtime/appServer/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../runtime/appServer/client.js')>();
  return {
    ...actual,
    createCodexNativeAppServerClient: async () => ({
      launchFeatures: {
        realtimeConversationAdvertised: false,
        codexCliVersion: null,
        realtimeConversationVersionSupported: false,
      },
      request: async (method: string, params?: unknown) => {
        if (method !== 'thread/list') return {};
        const archived = Boolean((params as { archived?: boolean } | undefined)?.archived);
        return {
          data: archived ? [] : appServerProbe.threads,
          nextCursor: null,
        };
      },
      notify: async () => {},
      registerRequestHandler: () => () => {},
      registerNotificationHandler: () => () => {},
      onExit: () => () => {},
      dispose: async () => {},
    }),
  };
});

import { listCodexSessionCandidates } from './candidateSource.js';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(() => {
  vi.restoreAllMocks();
  appServerProbe.threads = [];
});

describe('Codex external-session candidate pagination', () => {
  it('drains a mixed app-server and rollout corpus exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-pagination-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });

      // Six rollout-backed sessions, newest first by mtime.
      const rolloutIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const remoteSessionId = `${String(index).repeat(8)}-1111-1111-1111-111111111111`;
        rolloutIds.push(remoteSessionId);
        const filePath = join(sessionsDir, `rollout-2026-07-23T10-0${index}-00-${remoteSessionId}.jsonl`);
        await writeFile(
          filePath,
          jsonl({
            type: 'session_meta',
            timestamp: '2026-07-23T10:00:00.000Z',
            payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
          }),
          'utf8',
        );
        // Newest rollout first: index 0 is the most recently updated.
        const mtime = new Date(Date.parse('2026-07-23T12:00:00.000Z') - index * 60_000);
        await utimes(filePath, mtime, mtime);
      }

      // Two app-server threads that interleave with the rollout ordering.
      appServerProbe.threads = [
        { id: 'app-server-newest', updatedAt: Date.parse('2026-07-23T13:00:00.000Z') / 1000, cwd: '/repo' },
        { id: 'app-server-oldest', updatedAt: Date.parse('2026-07-23T11:00:00.000Z') / 1000, cwd: '/repo' },
      ];

      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        exec: {
          systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
        } as unknown as ExecService,
        limit: 2,
        searchMode: 'full',
      } as const;

      const drained: string[] = [];
      const cursors: (string | null)[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const result = await listCodexSessionCandidates({
          ...request,
          ...(cursor ? { cursor } : {}),
        });
        drained.push(...result.candidates.map((candidate) => candidate.remoteSessionId));
        cursors.push(result.nextCursor);
        if (!result.nextCursor) break;
        // A cursor that repeats itself is an infinite page loop, not progress.
        expect(cursors.filter((value) => value === result.nextCursor)).toHaveLength(1);
        cursor = result.nextCursor;
      }

      expect(cursors.at(-1)).toBeNull();
      expect(new Set(drained).size).toBe(drained.length);
      expect([...drained].sort()).toEqual(
        [...rolloutIds, 'app-server-newest', 'app-server-oldest'].sort(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
