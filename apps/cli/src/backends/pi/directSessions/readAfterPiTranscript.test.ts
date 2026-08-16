import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { encodePiForwardCursor } from './pagePiTranscript';
import { readAfterPiTranscript } from './readAfterPiTranscript';

const SESSION_ID = '019f4a42-4617-767a-8e7c-189b454a0352';
const FILE_REL = `projects/2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl`;

function writeSession(agentDir: string, lines: readonly object[]): { source: DirectSessionsSource; env: NodeJS.ProcessEnv } {
  const sessionsDir = join(agentDir, 'sessions', '--proj--');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, `2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return { source: { kind: 'piAgentDir' }, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } };
}

function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-readafter-'));
}

const header = { type: 'session', id: SESSION_ID, timestamp: '2024-12-03T14:00:00.000Z', cwd: '/proj', version: 3 };

function msg(id: string, parentId: string | null, role: string, text: string, ts: string): object {
  return { type: 'message', id, parentId, timestamp: ts, message: { role, content: [{ type: 'text', text }], timestamp: Date.parse(ts) } };
}

const THREE_MESSAGES = [
  header,
  msg('aaaa0001', null, 'user', 'one', '2024-12-03T14:00:01.000Z'),
  msg('bbbb0001', 'aaaa0001', 'assistant', 'two', '2024-12-03T14:00:02.000Z'),
  msg('cccc0001', 'bbbb0001', 'user', 'three', '2024-12-03T14:00:03.000Z'),
];

const LIMITS = { maxBytes: 1024 * 1024, maxItems: 100 };

async function withThreeMessages<T>(run: (params: { source: DirectSessionsSource; env: NodeJS.ProcessEnv }) => Promise<T>): Promise<T> {
  const agentDir = freshAgentDir();
  const { source, env } = writeSession(agentDir, THREE_MESSAGES);
  return await run({ source, env });
}

describe('readAfterPiTranscript cursor contract', () => {
  it("answers the 'tail' sentinel with no items and an end-positioned cursor (claude parity)", async () => {
    await withThreeMessages(async ({ source, env }) => {
      const res = await readAfterPiTranscript({
        source, env, remoteSessionId: SESSION_ID, cursor: 'tail', ...LIMITS,
      });
      expect(res.items).toEqual([]);
      expect(res.truncated).toBe(false);
      // A resumable cursor at the end of the active branch: polling with it must replay nothing.
      expect(res.nextCursor).toBe(encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: 3 }));
    });
  });

  it('returns a non-null cursor when fully caught up so the poller never falls back to tail', async () => {
    await withThreeMessages(async ({ source, env }) => {
      const res = await readAfterPiTranscript({
        source, env, remoteSessionId: SESSION_ID,
        cursor: encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: 3 }),
        ...LIMITS,
      });
      expect(res.items).toEqual([]);
      expect(res.truncated).toBe(false);
      expect(res.nextCursor).toBe(encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: 3 }));
    });
  });

  it('returns the remainder for a mid-branch cursor and a non-null cursor when truncated', async () => {
    await withThreeMessages(async ({ source, env }) => {
      const res = await readAfterPiTranscript({
        source, env, remoteSessionId: SESSION_ID,
        cursor: encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: 1 }),
        ...LIMITS,
      });
      expect(res.items).toHaveLength(2);
      expect(res.truncated).toBe(false);
      expect(res.nextCursor).toBe(encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: 3 }));

      const capped = await readAfterPiTranscript({
        source, env, remoteSessionId: SESSION_ID,
        cursor: encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: 1 }),
        maxBytes: 1, maxItems: 1,
      });
      expect(capped.items).toHaveLength(1);
      expect(capped.truncated).toBe(true);
      expect(capped.nextCursor).toBe(encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: 2 }));
    });
  });

  it('returns an end-positioned cursor for tail when byte limits would truncate a replay', async () => {
    await withThreeMessages(async ({ source, env }) => {
      const res = await readAfterPiTranscript({
        source, env, remoteSessionId: SESSION_ID, cursor: 'tail', maxBytes: 1, maxItems: 1,
      });
      expect(res.items).toEqual([]);
      expect(res.truncated).toBe(false);
      expect(res.nextCursor).toBe(encodePiForwardCursor({ v: 1, kind: 'piForward', delivered: 3 }));
    });
  });
});
