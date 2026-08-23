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

  it('keeps an identity that both halves report in one stable merged position while paging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-overlap-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });

      // Six rollout sessions, newest first. The fourth one is ALSO an app-server
      // thread, and the app-server reports it as the newest session of all — the
      // real shape when a live thread has already flushed a rollout file.
      const rolloutIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const remoteSessionId = `${String(index + 1).repeat(8)}-1111-1111-1111-111111111111`;
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
        const mtime = new Date(Date.parse('2026-07-23T12:00:00.000Z') - index * 3_600_000);
        await utimes(filePath, mtime, mtime);
      }
      const overlappingId = rolloutIds[3]!;

      appServerProbe.threads = [
        { id: overlappingId, updatedAt: Date.parse('2026-07-23T12:30:00.000Z') / 1000, cwd: '/repo' },
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
      let cursor: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const result = await listCodexSessionCandidates({
          ...request,
          ...(cursor ? { cursor } : {}),
        });
        drained.push(...result.candidates.map((candidate) => candidate.remoteSessionId));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      // The overlapping identity must be served exactly once (a prefix-depth
      // change must not move it across the cursor)...
      expect(drained.filter((id) => id === overlappingId)).toHaveLength(1);
      // ...and displacing it must not push a neighbour behind the cursor.
      expect([...drained].sort()).toEqual([...rolloutIds].sort());

      // The complete half owns the merged row for an identity both halves
      // report, so its runtime descriptor survives into link data.
      const first = await listCodexSessionCandidates(request);
      const overlapping = first.candidates.find((c) => c.remoteSessionId === overlappingId);
      expect(overlapping?.details?.codexBackendMode).toBe('appServer');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('serves every identity once when an overlapping app-server row sorts older than its rollout row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-overlap-older-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });

      // Six rollout sessions, newest first by mtime (12:00 down to 07:00).
      const rolloutIds: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const remoteSessionId = `${String(index + 1).repeat(8)}-1111-1111-1111-111111111111`;
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
        const mtime = new Date(Date.parse('2026-07-23T12:00:00.000Z') - index * 3_600_000);
        await utimes(filePath, mtime, mtime);
      }
      // The second-newest rollout is also a live app-server thread whose recorded
      // `updatedAt` is OLDER than every rollout mtime — the real shape when the
      // rollout file is touched after the thread record was last written. The
      // app-server row wins the merge, so this identity's ordering key drops to
      // the bottom of whatever rollout prefix the page happens to have read.
      const overlappingId = rolloutIds[1]!;
      appServerProbe.threads = [
        { id: overlappingId, updatedAt: Date.parse('2026-07-23T06:00:00.000Z') / 1000, cwd: '/repo' },
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
      let cursor: string | undefined;
      for (let page = 0; page < 12; page += 1) {
        const result = await listCodexSessionCandidates({
          ...request,
          ...(cursor ? { cursor } : {}),
        });
        drained.push(...result.candidates.map((candidate) => candidate.remoteSessionId));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }

      // Direction 1: no identity is served twice.
      expect(drained.filter((id) => id === overlappingId)).toHaveLength(1);
      expect(new Set(drained).size).toBe(drained.length);
      // Direction 2: nothing the displaced row shifted past is omitted.
      expect([...drained].sort()).toEqual([...rolloutIds].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
