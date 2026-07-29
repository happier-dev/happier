import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsProbe = vi.hoisted(() => ({
  statCalls: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      fsProbe.statCalls += 1;
      return await actual.stat(...args);
    },
  };
});

import { createCodexExternalSessionsContribution } from './contribution.js';
import { listCodexSessionCandidates } from './candidateSource.js';

function sessionMetaLine(remoteSessionId: string, timestamp: string): string {
  return `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: remoteSessionId,
      timestamp,
      cwd: '/repo/bounded-candidate-test',
    },
  })}\n`;
}

function invocation() {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes: 64 * 1024,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  fsProbe.statCalls = 0;
});

describe('Codex rollout candidate paging bounds', () => {
  it('returns page one without statting the whole native date bucket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-bounded-'));
    try {
      const codexHome = join(root, 'codex-home');
      const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(dayDir, { recursive: true });
      await Promise.all(Array.from({ length: 256 }, async (_, index) => {
        const second = String(index % 60).padStart(2, '0');
        const minute = String(Math.trunc(index / 60) % 60).padStart(2, '0');
        const hour = String(Math.trunc(index / 3600) % 24).padStart(2, '0');
        const suffix = String(index).padStart(12, '0');
        const remoteSessionId = `00000000-0000-0000-0000-${suffix}`;
        const timestamp = `2026-07-23T${hour}:${minute}:${second}.000Z`;
        await writeFile(
          join(dayDir, `rollout-2026-07-23T${hour}-${minute}-${second}-${remoteSessionId}.jsonl`),
          sessionMetaLine(remoteSessionId, timestamp),
          'utf8',
        );
      }));

      fsProbe.statCalls = 0;
      const firstPage = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        limit: 2,
        searchMode: 'fast',
      });

      expect(firstPage.candidates).toHaveLength(2);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      expect(fsProbe.statCalls).toBeLessThanOrEqual(20);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('continues a stable rollout set without duplicate candidate identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-continuation-'));
    try {
      const codexHome = join(root, 'codex-home');
      const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(dayDir, { recursive: true });
      const ids = [
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
      ] as const;
      for (const [index, remoteSessionId] of ids.entries()) {
        const hour = String(8 + index).padStart(2, '0');
        await writeFile(
          join(dayDir, `rollout-2026-07-23T${hour}-00-00-${remoteSessionId}.jsonl`),
          sessionMetaLine(remoteSessionId, `2026-07-23T${hour}:00:00.000Z`),
          'utf8',
        );
      }

      const firstPage = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        limit: 2,
        searchMode: 'fast',
      });
      if (!firstPage.nextCursor) throw new Error('Expected candidate continuation');
      const secondPage = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        cursor: firstPage.nextCursor,
        limit: 2,
        searchMode: 'fast',
      });

      expect(firstPage.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
        ids[2],
        ids[1],
      ]);
      expect(secondPage.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
        ids[0],
      ]);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a typed source-invalid result when the rollout set mutates between pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-generation-'));
    try {
      const codexHome = join(root, 'codex-home');
      const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(dayDir, { recursive: true });
      for (const [time, remoteSessionId] of [
        ['08-00-00', '11111111-1111-1111-1111-111111111111'],
        ['09-00-00', '22222222-2222-2222-2222-222222222222'],
      ] as const) {
        await writeFile(
          join(dayDir, `rollout-2026-07-23T${time}-${remoteSessionId}.jsonl`),
          sessionMetaLine(remoteSessionId, `2026-07-23T${time.replaceAll('-', ':')}.000Z`),
          'utf8',
        );
      }
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome },
        activeServerDir: join(root, 'active-server'),
      });
      const source = { kind: 'codexHome', home: 'user' } as const;
      const firstPage = await contribution.listCandidates({
        source,
        maxItems: 1,
        searchMode: 'fast',
        ...invocation(),
      });
      if (!firstPage.ok || !firstPage.value.nextCursor) {
        throw new Error('Expected a candidate continuation cursor');
      }

      const addedSessionId = '33333333-3333-3333-3333-333333333333';
      await writeFile(
        join(dayDir, `rollout-2026-07-23T10-00-00-${addedSessionId}.jsonl`),
        sessionMetaLine(addedSessionId, '2026-07-23T10:00:00.000Z'),
        'utf8',
      );

      await expect(contribution.listCandidates({
        source,
        cursor: firstPage.value.nextCursor,
        maxItems: 1,
        searchMode: 'fast',
        ...invocation(),
      })).resolves.toMatchObject({
        ok: false,
        code: 'source_invalid',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
