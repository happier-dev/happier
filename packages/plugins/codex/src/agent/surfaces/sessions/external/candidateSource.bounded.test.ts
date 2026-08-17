import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

const fsProbe = vi.hoisted(() => ({
  openCalls: 0,
  readCalls: 0,
  statCalls: 0,
  abortAtReadCall: null as number | null,
  abortAtStatCall: null as number | null,
  abortController: null as AbortController | null,
  advanceDeadlineAtReadCall: null as number | null,
  advanceDeadlineAtStatCall: null as number | null,
  advanceDeadline: null as (() => void) | null,
}));

// Fast candidate tests must not touch the app-server client.
const fastModeExec = {} as ExecService;

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      fsProbe.openCalls += 1;
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...readArgs: Parameters<typeof target.read>) => {
              fsProbe.readCalls += 1;
              if (fsProbe.readCalls === fsProbe.abortAtReadCall) {
                fsProbe.abortController?.abort();
              }
              if (fsProbe.readCalls === fsProbe.advanceDeadlineAtReadCall) {
                fsProbe.advanceDeadline?.();
              }
              return await Reflect.apply(target.read, target, readArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      fsProbe.statCalls += 1;
      if (fsProbe.statCalls === fsProbe.abortAtStatCall) {
        fsProbe.abortController?.abort('mid-candidate-scan');
      }
      if (fsProbe.statCalls === fsProbe.advanceDeadlineAtStatCall) {
        fsProbe.advanceDeadline?.();
      }
      return await actual.stat(...args);
    },
  };
});

import { createCodexExternalSessionsContribution } from './contribution.js';
import {
  listCodexExternalSessionCandidatesViaExistingAppServerClient,
  listCodexSessionCandidates,
} from './candidateSource.js';
import type { CodexAppServerClient } from '../../../runtime/appServer/client.js';

function sessionMetaLine(
  remoteSessionId: string,
  timestamp: string,
  paddingBytes = 0,
): string {
  return `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: remoteSessionId,
      timestamp,
      cwd: '/repo/bounded-candidate-test',
      ...(paddingBytes > 0 ? { padding: 'x'.repeat(paddingBytes) } : {}),
    },
  })}\n`;
}

function invocation() {
  return {
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes: 64 * 1024,
    exec: fastModeExec,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  fsProbe.openCalls = 0;
  fsProbe.readCalls = 0;
  fsProbe.statCalls = 0;
  fsProbe.abortAtReadCall = null;
  fsProbe.abortAtStatCall = null;
  fsProbe.abortController = null;
  fsProbe.advanceDeadlineAtReadCall = null;
  fsProbe.advanceDeadlineAtStatCall = null;
  fsProbe.advanceDeadline = null;
});

describe('Codex rollout candidate paging bounds', () => {
  async function writeCandidateCorpus(
    root: string,
    count: number,
    paddingBytes = 0,
  ): Promise<string> {
    const codexHome = join(root, 'codex-home');
    const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
    await mkdir(dayDir, { recursive: true });
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const second = String(index % 60).padStart(2, '0');
      const suffix = String(index).padStart(12, '0');
      const remoteSessionId = `00000000-0000-0000-0000-${suffix}`;
      await writeFile(
        join(dayDir, `rollout-2026-07-23T08-00-${second}-${remoteSessionId}.jsonl`),
        sessionMetaLine(
          remoteSessionId,
          `2026-07-23T08:00:${second}.000Z`,
          paddingBytes,
        ),
        'utf8',
      );
    }));
    return codexHome;
  }

  it('stops parallel candidate metadata reads after an early read aborts the invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-read-abort-'));
    try {
      const codexHome = await writeCandidateCorpus(root, 1, 10 * 1024);
      const controller = new AbortController();
      fsProbe.openCalls = 0;
      fsProbe.readCalls = 0;
      fsProbe.abortAtReadCall = 1;
      fsProbe.abortController = controller;

      await expect(listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        exec: fastModeExec,
        limit: 1,
        // Rollout metadata is read on the exact-id search/hydration route;
        // unsearched browse builds bounded scan chunks from filenames alone.
        searchTerm: '00000000-0000-0000-0000-000000000000',
        searchMode: 'fast',
        signal: controller.signal,
        deadlineAtMs: Date.now() + 30_000,
      })).rejects.toMatchObject({ name: 'AbortError' });

      const settledOpenCalls = fsProbe.openCalls;
      const settledReadCalls = fsProbe.readCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledOpenCalls).toBeGreaterThan(1);
      expect(settledReadCalls).toBe(1);
      expect(fsProbe.readCalls).toBe(settledReadCalls);
      expect(fsProbe.openCalls).toBe(settledOpenCalls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops parallel candidate metadata reads after an early read exhausts the invocation deadline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-read-deadline-'));
    try {
      const codexHome = await writeCandidateCorpus(root, 1, 10 * 1024);
      let nowMs = Date.now();
      const deadlineAtMs = nowMs + 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      fsProbe.openCalls = 0;
      fsProbe.readCalls = 0;
      fsProbe.advanceDeadlineAtReadCall = 1;
      fsProbe.advanceDeadline = () => {
        nowMs = deadlineAtMs;
      };

      await expect(listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        exec: fastModeExec,
        limit: 1,
        searchTerm: '00000000-0000-0000-0000-000000000000',
        searchMode: 'fast',
        deadlineAtMs,
      })).rejects.toMatchObject({ name: 'TimeoutError' });

      const settledOpenCalls = fsProbe.openCalls;
      const settledReadCalls = fsProbe.readCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledOpenCalls).toBeGreaterThan(1);
      expect(settledReadCalls).toBe(1);
      expect(fsProbe.readCalls).toBe(settledReadCalls);
      expect(fsProbe.openCalls).toBe(settledOpenCalls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops candidate filesystem effects when the invocation aborts mid-scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-abort-'));
    try {
      const codexHome = await writeCandidateCorpus(root, 64);
      const controller = new AbortController();
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome },
        activeServerDir: join(root, 'active-server'),
      });
      fsProbe.statCalls = 0;
      fsProbe.abortAtStatCall = 2;
      fsProbe.abortController = controller;

      await expect(contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user' },
        maxItems: 16,
        searchMode: 'fast',
        ...invocation(),
        signal: controller.signal,
      })).resolves.toMatchObject({ ok: false, code: 'cancelled' });

      const settledStatCalls = fsProbe.statCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledStatCalls).toBe(2);
      expect(fsProbe.statCalls).toBe(settledStatCalls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not issue another app-server page after a mid-operation abort', async () => {
    const controller = new AbortController();
    let requestCalls = 0;
    const client = {
      async request() {
        requestCalls += 1;
        controller.abort(new Error('mid-app-server-list'));
        return { data: [], nextCursor: 'next-page' };
      },
      async notify() {},
      registerRequestHandler: () => () => {},
      registerNotificationHandler: () => () => {},
    } satisfies CodexAppServerClient;

    await expect(listCodexExternalSessionCandidatesViaExistingAppServerClient({
      client,
      processEnv: {},
      signal: controller.signal,
      deadlineAtMs: Date.now() + 30_000,
    })).rejects.toThrow('mid-app-server-list');

    const settledRequestCalls = requestCalls;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settledRequestCalls).toBe(1);
    expect(requestCalls).toBe(settledRequestCalls);
  });

  it('stops candidate filesystem effects when the invocation deadline expires mid-scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-deadline-'));
    try {
      const codexHome = await writeCandidateCorpus(root, 64);
      let nowMs = Date.now();
      const deadlineAtMs = nowMs + 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome },
        activeServerDir: join(root, 'active-server'),
      });
      fsProbe.statCalls = 0;
      fsProbe.advanceDeadlineAtStatCall = 2;
      fsProbe.advanceDeadline = () => {
        nowMs = deadlineAtMs;
      };

      await expect(contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user' },
        maxItems: 16,
        searchMode: 'fast',
        ...invocation(),
        deadlineAtMs,
      })).resolves.toMatchObject({ ok: false, code: 'timeout' });

      const settledStatCalls = fsProbe.statCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledStatCalls).toBe(2);
      expect(fsProbe.statCalls).toBe(settledStatCalls);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns page one without reading the whole native date bucket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-bounded-'));
    try {
      const codexHome = join(root, 'codex-home');
      const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(dayDir, { recursive: true });
      const newestByActivity: string[] = [];
      for (let index = 0; index < 256; index += 1) {
        const second = String(index % 60).padStart(2, '0');
        const minute = String(Math.trunc(index / 60) % 60).padStart(2, '0');
        const hour = String(Math.trunc(index / 3600) % 24).padStart(2, '0');
        const suffix = String(index).padStart(12, '0');
        const remoteSessionId = `00000000-0000-0000-0000-${suffix}`;
        const timestamp = `2026-07-23T${hour}:${minute}:${second}.000Z`;
        const filePath = join(
          dayDir,
          `rollout-2026-07-23T${hour}-${minute}-${second}-${remoteSessionId}.jsonl`,
        );
        await writeFile(filePath, sessionMetaLine(remoteSessionId, timestamp), 'utf8');
        // Last activity runs opposite to creation order, so a page built from the
        // rollout filenames alone cannot produce the expected two rows.
        const activityAtMs = Date.parse('2026-07-24T00:00:00.000Z') + (256 - index) * 60_000;
        await utimes(filePath, new Date(activityAtMs), new Date(activityAtMs));
        newestByActivity.push(remoteSessionId);
      }

      fsProbe.openCalls = 0;
      fsProbe.readCalls = 0;
      const request = {
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        exec: fastModeExec,
        limit: 64,
        searchMode: 'fast',
      } as const;
      const firstChunk = await listCodexSessionCandidates(request);

      expect(firstChunk.candidates).toHaveLength(64);
      expect(firstChunk.preparation).toEqual({ kind: 'building_candidate_index', scanned: 64 });
      expect(firstChunk.nextCursor).toEqual(expect.any(String));
      // Complete work — not only rollout content opens — stays proportional to
      // the chunk, so one chunk cannot exceed the source head-acquisition budget
      // on a corpus far larger than this bucket. A row the chunk RETURNS costs
      // one bounded head read for its title; a row it merely traverses past
      // costs nothing, which is what keeps the cost proportional.
      expect(fsProbe.openCalls).toBeLessThanOrEqual(64);
      expect(fsProbe.readCalls).toBeLessThanOrEqual(64 * 2);
      expect(fsProbe.statCalls).toBeLessThanOrEqual((64 * 2) + 8);

      // The chunks are exact: drained and sorted by the ordering rule the host
      // candidate index applies, they reproduce the whole bucket in last-activity
      // order — which no single bounded chunk could compute for itself.
      const drained = [...firstChunk.candidates];
      let cursor = firstChunk.nextCursor;
      while (cursor) {
        const next = await listCodexSessionCandidates({ ...request, cursor });
        drained.push(...next.candidates);
        cursor = next.nextCursor;
      }
      expect(drained).toHaveLength(256);
      expect(
        [...drained]
          .sort((left, right) =>
            right.updatedAtMs - left.updatedAtMs
            || (left.remoteSessionId < right.remoteSessionId ? -1 : 1),
          )
          .map((candidate) => candidate.remoteSessionId),
      ).toEqual(newestByActivity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps selected-candidate title extraction within the rollout head budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-title-head-'));
    try {
      const codexHome = join(root, 'codex-home');
      const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      await mkdir(dayDir, { recursive: true });
      await writeFile(
        join(dayDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`),
        [
          sessionMetaLine(remoteSessionId, '2026-07-23T08:00:00.000Z'),
          ...Array.from({ length: 5 }, (_, index) => `${JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'developer',
              content: [{ type: 'input_text', text: `<instructions>${index}${'x'.repeat(128 * 1024)}</instructions>` }],
            },
          })}\n`),
          `${JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Title beyond the bounded head' }],
            },
          })}\n`,
        ].join(''),
        'utf8',
      );

      const page = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        exec: fastModeExec,
        limit: 1,
        searchTerm: remoteSessionId,
        searchMode: 'fast',
      });

      expect(page.candidates).toHaveLength(1);
      expect(page.candidates[0]).not.toHaveProperty('title');
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
        const filePath = join(dayDir, `rollout-2026-07-23T${hour}-00-00-${remoteSessionId}.jsonl`);
        await writeFile(
          filePath,
          sessionMetaLine(remoteSessionId, `2026-07-23T${hour}:00:00.000Z`),
          'utf8',
        );
        // Pin last activity to the reverse of creation order so continuation is
        // proven against the ordering key the list actually shows.
        const activityAtMs = Date.parse('2026-07-24T00:00:00.000Z') - index * 3_600_000;
        await utimes(filePath, new Date(activityAtMs), new Date(activityAtMs));
      }

      const firstPage = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        exec: fastModeExec,
        limit: 2,
        searchMode: 'fast',
      });
      if (!firstPage.nextCursor) throw new Error('Expected candidate continuation');
      const secondPage = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        exec: fastModeExec,
        cursor: firstPage.nextCursor,
        limit: 2,
        searchMode: 'fast',
      });

      // Chunks traverse newest creation stamp first — here the exact reverse of
      // last activity — and each chunk is internally ordered by the same rule the
      // host index applies across chunks.
      expect(firstPage.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
        ids[1],
        ids[2],
      ]);
      expect(secondPage.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
        ids[0],
      ]);
      expect(secondPage.nextCursor).toBeNull();
      expect(firstPage.preparation?.scanned).toBe(2);
      expect(secondPage.preparation?.scanned).toBe(3);
      expect(
        [...firstPage.candidates, ...secondPage.candidates]
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
          .map((candidate) => candidate.remoteSessionId),
      ).toEqual([ids[0], ids[1], ids[2]]);
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
