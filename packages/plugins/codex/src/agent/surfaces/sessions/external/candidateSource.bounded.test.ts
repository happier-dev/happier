import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
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
  bytesReadByPath: new Map<string, number>(),
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
      const openedPath = String(args[0]);
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
              const result = await Reflect.apply(target.read, target, readArgs) as Awaited<ReturnType<typeof target.read>>;
              fsProbe.bytesReadByPath.set(openedPath, (fsProbe.bytesReadByPath.get(openedPath) ?? 0) + result.bytesRead);
              return result;
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

import { resolveExternalSessionCandidateIdentityKey } from '@happier-dev/plugin-sdk/sessions/external';
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
  fsProbe.bytesReadByPath.clear();
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
      const firstPage = await listCodexSessionCandidates(request);

      // Browse orders by last activity, and that fact is the rollout mtime: one
      // stat pass orders the whole corpus, and only the rows page 1 shows have
      // their heads read. No index build, no preparation round-trips.
      expect(firstPage.preparation).toBeUndefined();
      expect(firstPage.candidates.map((candidate) => candidate.remoteSessionId))
        .toEqual(newestByActivity.slice(0, 64));
      expect(fsProbe.openCalls).toBeLessThanOrEqual(64);
      expect(fsProbe.readCalls).toBeLessThanOrEqual(64 * 2);
      expect(firstPage.nextCursor).toEqual(expect.any(String));

      // The continuation resumes strictly after the last shown row, in the same
      // order, without repeating or skipping a row.
      const drained = [...firstPage.candidates];
      let cursor = firstPage.nextCursor;
      while (cursor) {
        const next = await listCodexSessionCandidates({ ...request, cursor });
        expect(next.preparation).toBeUndefined();
        drained.push(...next.candidates);
        cursor = next.nextCursor;
      }
      expect(drained.map((candidate) => candidate.remoteSessionId)).toEqual(newestByActivity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serves an ordinary unsearched browse as one activity page with a seek continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-ordinary-'));
    try {
      const codexHome = await writeCandidateCorpus(root, 24);

      fsProbe.openCalls = 0;
      // No searchMode and no searchTerm: the ordinary mounted machine Browse.
      const firstPage = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        exec: fastModeExec,
        limit: 4,
      });

      expect(firstPage.candidates).toHaveLength(4);
      expect(firstPage.preparation).toBeUndefined();
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      // Only the shown rows' heads are opened.
      expect(fsProbe.openCalls).toBeLessThanOrEqual(4);

      const secondPage = await listCodexSessionCandidates({
        source: { kind: 'codexHome', home: 'user' },
        activeServerDir: join(root, 'active-server'),
        env: { CODEX_HOME: codexHome },
        exec: fastModeExec,
        cursor: firstPage.nextCursor ?? undefined,
        limit: 4,
      });
      expect(secondPage.candidates).toHaveLength(4);
      const shown = [...firstPage.candidates, ...secondPage.candidates];
      expect(new Set(shown.map((candidate) => candidate.remoteSessionId)).size).toBe(8);
      expect(shown.map((candidate) => candidate.remoteSessionId)).toEqual(
        [...shown].sort((left, right) => right.updatedAtMs - left.updatedAtMs
          || (left.remoteSessionId < right.remoteSessionId ? -1 : 1)).map((candidate) => candidate.remoteSessionId),
      );
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

      // Pages follow last activity — here the exact reverse of creation order.
      expect(firstPage.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
        ids[0],
        ids[1],
      ]);
      expect(secondPage.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
        ids[2],
      ]);
      expect(secondPage.nextCursor).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['newer file', 'older file', 'append', 'removed container', 'replaced container'] as const)(
    'continues strictly below the last shown row while the rollout set changes (%s)', async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-generation-'));
    try {
      const codexHome = join(root, 'codex-home');
      const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(dayDir, { recursive: true });
      const first = '11111111-1111-1111-1111-111111111111';
      const second = '22222222-2222-2222-2222-222222222222';
      const writeRollout = async (time: string, id: string, activity: string) => {
        const filePath = join(dayDir, `rollout-2026-07-23T${time}-${id}.jsonl`);
        await writeFile(filePath, sessionMetaLine(id, `2026-07-23T${time.replaceAll('-', ':')}.000Z`), 'utf8');
        await utimes(filePath, new Date(activity), new Date(activity));
      };
      await writeRollout('08-00-00', first, '2026-07-23T08:30:00.000Z');
      await writeRollout('09-00-00', second, '2026-07-23T09:30:00.000Z');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome },
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
      expect(firstPage.value.candidates.map(({ remoteSessionId }) => remoteSessionId)).toEqual([second]);

      const addedSessionId = '33333333-3333-3333-3333-333333333333';
      if (change === 'removed container' || change === 'replaced container') {
        await rename(dayDir, join(root, 'moved-out-of-codex-home'));
        if (change === 'replaced container') {
          await mkdir(dayDir);
          await writeRollout('08-00-00', first, '2026-07-23T08:30:00.000Z');
          await writeRollout('09-00-00', second, '2026-07-23T09:30:00.000Z');
        }
      } else if (change === 'append') {
        const filePath = join(dayDir, `rollout-2026-07-23T08-00-00-${first}.jsonl`);
        await appendFile(filePath,
          `${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'live append' } })}\n`);
        await utimes(filePath, new Date('2026-07-23T10:30:00.000Z'), new Date('2026-07-23T10:30:00.000Z'));
      } else {
        // A new rollout's activity is its write time, whatever its creation stamp.
        await writeRollout(change === 'newer file' ? '10-00-00' : '07-00-00', addedSessionId, '2026-07-23T11:00:00.000Z');
      }

      const secondPage = await contribution.listCandidates({
        source,
        cursor: firstPage.value.nextCursor,
        maxItems: 1,
        searchMode: 'fast',
        ...invocation(),
      });
      if (!secondPage.ok) throw new Error(`Unexpected ${secondPage.code}: ${secondPage.message}`);
      // The continuation resumes strictly after the last shown row's activity
      // position. A row whose activity moved above it is shown by the next
      // fresh first page, never repeated or shown out of order here.
      expect(secondPage.value.candidates.map(({ remoteSessionId }) => remoteSessionId))
        .toEqual(change === 'append' || change === 'removed container' ? [] : [first]);
      expect(secondPage.value.nextCursor).toBeNull();
      const fresh = await contribution.listCandidates({ source, maxItems: 3, searchMode: 'fast', ...invocation() });
      if (!fresh.ok) throw new Error(`Unexpected ${fresh.code}: ${fresh.message}`);
      expect(fresh.value.candidates.map(({ remoteSessionId }) => remoteSessionId)).toEqual(
        change === 'append' ? [first, second]
          : change === 'removed container' ? []
            : change === 'replaced container' ? [second, first]
              : [addedSessionId, second, first],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Codex rollout candidate head reads across index slices', () => {
  function userMessageLine(text: string): string {
    return `${JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    })}\n`;
  }

  /**
   * Every unsearched Browse request re-lists the corpus head to anchor the host
   * candidate index, so an unchanged rollout must not have its head re-read on
   * each slice: the host hands back the checkpoint the previous slice produced.
   * The only boundary is node:fs, counted through the real implementation.
   */
  it('reuses the indexed head of unchanged rollouts and re-reads only a changed one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-head-state-'));
    try {
      const codexHome = join(root, 'codex-home');
      const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(dayDir, { recursive: true });
      const ids = [0, 1, 2, 3].map((index) => `00000000-0000-0000-0000-00000000000${index}`);
      const filePathFor = (index: number) => join(dayDir, `rollout-2026-07-23T08-00-0${index}-${ids[index]}.jsonl`);
      await Promise.all(ids.map(async (id, index) => {
        await writeFile(filePathFor(index), [
          sessionMetaLine(id, `2026-07-23T08:00:0${index}.000Z`, 4 * 1024),
          ...(index === 3 ? [] : [userMessageLine(`head title ${index}`)]),
        ].join(''), 'utf8');
      }));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      const source = { kind: 'codexHome', home: 'user' } as const;
      const states = new Map<string, unknown>();
      const listSlice = async () => {
        const page = await contribution.listCandidates({
          source,
          maxItems: 4,
          searchMode: 'fast',
          readCandidateIndexState: (candidate) => states.get(resolveExternalSessionCandidateIdentityKey(candidate)) as never,
          ...invocation(),
        });
        if (!page.ok) throw new Error(`Unexpected ${page.code}: ${page.message}`);
        for (const candidate of page.value.candidates) {
          if (candidate.candidateIndexState !== undefined) {
            states.set(resolveExternalSessionCandidateIdentityKey(candidate), candidate.candidateIndexState);
          }
        }
        return Object.fromEntries(page.value.candidates.map((candidate) => [candidate.remoteSessionId, candidate.title ?? null]));
      };

      const first = await listSlice();
      expect(first).toEqual({
        [ids[0]!]: 'head title 0', [ids[1]!]: 'head title 1', [ids[2]!]: 'head title 2', [ids[3]!]: null,
      });

      fsProbe.openCalls = 0;
      const second = await listSlice();
      const unchangedHeadOpens = fsProbe.openCalls;

      // A rollout still inside its head window grows: its title may now exist.
      await appendFile(filePathFor(3), userMessageLine('head title 3'), 'utf8');
      fsProbe.openCalls = 0;
      const third = await listSlice();
      const changedHeadOpens = fsProbe.openCalls;

      expect({ second, unchangedHeadOpens, third: third[ids[3]!], changedHeadOpens }).toEqual({
        second: first,
        unchangedHeadOpens: 0,
        third: 'head title 3',
        changedHeadOpens: 1,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * A top-level Browse listing drops internal threads, which are about half of
   * a real corpus. Line 1's `session_meta` already classifies a thread, so only
   * the first head page is read for a row the listing discards, never the rest
   * of its 512 KiB title window (this body opens with a 320 KB record).
   */
  it('classifies an internal thread from its first record without reading its title window in a top-level listing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-thread-head-'));
    try {
      const codexHome = join(root, 'codex-home');
      const dayDir = join(codexHome, 'sessions', '2026', '07', '24');
      await mkdir(dayDir, { recursive: true });
      const rootId = '00000000-0000-0000-0000-0000000000a1';
      const childId = '00000000-0000-0000-0000-0000000000a2';
      const rootPath = join(dayDir, `rollout-2026-07-24T08-00-01-${rootId}.jsonl`);
      const childPath = join(dayDir, `rollout-2026-07-24T08-00-02-${childId}.jsonl`);
      // Real rollouts carry multi-hundred-KB records (instructions, tool output) early on.
      const body = `${userMessageLine('z'.repeat(320 * 1024))}${userMessageLine('child title')}`;
      await writeFile(rootPath, `${sessionMetaLine(rootId, '2026-07-24T08:00:01.000Z')}${userMessageLine('root title')}`, 'utf8');
      await writeFile(childPath, `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: childId, timestamp: '2026-07-24T08:00:02.000Z', cwd: '/repo/bounded-candidate-test',
          source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
        },
      })}\n${body}`, 'utf8');
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      const page = await contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user' },
        maxItems: 10,
        searchMode: 'fast',
        readCandidateIndexState: () => undefined,
        ...invocation(),
      });
      if (!page.ok) throw new Error(`Unexpected ${page.code}: ${page.message}`);
      expect({
        rows: page.value.candidates.map((candidate) => [candidate.remoteSessionId, candidate.title ?? null]),
        childBytesReadInOneHeadPage: (fsProbe.bytesReadByPath.get(childPath) ?? 0) <= 128 * 1024,
      }).toEqual({
        rows: [[rootId, 'root title']],
        childBytesReadInOneHeadPage: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
