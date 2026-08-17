import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsProbe = vi.hoisted(() => ({
  statCalls: 0,
  abortAtStatCall: null as number | null,
  abortController: null as AbortController | null,
  advanceDeadlineAtStatCall: null as number | null,
  advanceDeadline: null as (() => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      fsProbe.statCalls += 1;
      if (fsProbe.statCalls === fsProbe.abortAtStatCall) {
        fsProbe.abortController?.abort(new Error('mid-transcript-scan'));
      }
      if (fsProbe.statCalls === fsProbe.advanceDeadlineAtStatCall) {
        fsProbe.advanceDeadline?.();
      }
      return await actual.stat(...args);
    },
  };
});

import {
  pageCodexExternalSessionTranscript,
  readAfterCodexExternalSessionTranscript,
} from './transcriptSource.js';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function createFixture(): Promise<Readonly<{
  root: string;
  params: Readonly<{
    source: { kind: 'codexHome'; home: 'user' };
    activeServerDir: string;
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
  }>;
}>> {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-transcript-cancel-'));
  const codexHome = join(root, 'codex-home');
  const dayDir = join(codexHome, 'sessions', '2026', '07', '23');
  const remoteSessionId = '11111111-1111-1111-1111-111111111111';
  await mkdir(dayDir, { recursive: true });
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const second = String(index).padStart(2, '0');
    await writeFile(
      join(dayDir, `rollout-2026-07-23T08-00-${second}-${remoteSessionId}.jsonl`),
      [
        jsonl({
          type: 'session_meta',
          timestamp: `2026-07-23T08:00:${second}.000Z`,
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: `2026-07-23T08:01:${second}.000Z`,
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `bounded transcript ${index}` }],
          },
        }),
      ].join(''),
      'utf8',
    );
  }));
  return {
    root,
    params: {
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(root, 'active-server'),
      env: { CODEX_HOME: codexHome },
      remoteSessionId,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  fsProbe.statCalls = 0;
  fsProbe.abortAtStatCall = null;
  fsProbe.abortController = null;
  fsProbe.advanceDeadlineAtStatCall = null;
  fsProbe.advanceDeadline = null;
});

describe('Codex transcript invocation bounds', () => {
  it('stops page filesystem effects after a mid-operation abort', async () => {
    const fixture = await createFixture();
    try {
      const controller = new AbortController();
      fsProbe.statCalls = 0;
      fsProbe.abortAtStatCall = 2;
      fsProbe.abortController = controller;

      await expect(pageCodexExternalSessionTranscript({
        ...fixture.params,
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 10,
        signal: controller.signal,
        deadlineAtMs: Date.now() + 30_000,
      })).rejects.toThrow('mid-transcript-scan');

      const settledStatCalls = fsProbe.statCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledStatCalls).toBe(2);
      expect(fsProbe.statCalls).toBe(settledStatCalls);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('stops read-after filesystem effects after a mid-operation deadline', async () => {
    const fixture = await createFixture();
    try {
      const initial = await pageCodexExternalSessionTranscript({
        ...fixture.params,
        direction: 'older',
        maxBytes: 64 * 1024,
        maxItems: 10,
      });
      if (!initial.tailCursor) throw new Error('Expected a transcript tail cursor');

      let nowMs = Date.now();
      const deadlineAtMs = nowMs + 1_000;
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
      fsProbe.statCalls = 0;
      fsProbe.advanceDeadlineAtStatCall = 2;
      fsProbe.advanceDeadline = () => {
        nowMs = deadlineAtMs;
      };

      await expect(readAfterCodexExternalSessionTranscript({
        ...fixture.params,
        cursor: initial.tailCursor,
        maxBytes: 64 * 1024,
        maxItems: 10,
        signal: new AbortController().signal,
        deadlineAtMs,
      })).rejects.toMatchObject({ name: 'TimeoutError' });

      const settledStatCalls = fsProbe.statCalls;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledStatCalls).toBe(2);
      expect(fsProbe.statCalls).toBe(settledStatCalls);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
