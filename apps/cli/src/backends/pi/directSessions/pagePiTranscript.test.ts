import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { loadPiSessionEntries, pagePiTranscript } from './pagePiTranscript';

const SESSION_ID = '019f4a42-4617-767a-8e7c-189b454a0352';

function writeSession(agentDir: string, lines: readonly object[]): { source: DirectSessionsSource; env: NodeJS.ProcessEnv } {
  const sessionsDir = join(agentDir, 'sessions', '--proj--');
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, `2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return { source: { kind: 'piAgentDir' }, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } };
}

function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-page-'));
}

const header = { type: 'session', id: SESSION_ID, timestamp: '2024-12-03T14:00:00.000Z', cwd: '/proj', version: 3 };

function msg(id: string, parentId: string | null, role: string, text: string, ts: string): object {
  return { type: 'message', id, parentId, timestamp: ts, message: { role, content: [{ type: 'text', text }], timestamp: Date.parse(ts) } };
}

/** Mirror importDirectSessionTranscript's accumulation: collect older pages, reverse, flatten. */
async function importAll(source: DirectSessionsSource, env: NodeJS.ProcessEnv, opts: { maxBytes: number; maxItems: number }): Promise<DirectTranscriptRawMessageV1[]> {
  const pages: DirectTranscriptRawMessageV1[][] = [];
  let cursor: string | undefined;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await pagePiTranscript({ source, env, remoteSessionId: SESSION_ID, direction: 'older', cursor, ...opts });
    if (page.items.length > 0) pages.push(page.items.slice());
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const ordered: DirectTranscriptRawMessageV1[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1) ordered.push(...pages[i]!);
  return ordered;
}

describe('pagePiTranscript', () => {
  it('walks a linear session to completion in chronological order', async () => {
    const agentDir = freshAgentDir();
    const { source, env } = writeSession(agentDir, [
      header,
      msg('m1', null, 'user', 'one', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'two', '2024-12-03T14:00:02.000Z'),
      msg('m3', 'm2', 'user', 'three', '2024-12-03T14:00:03.000Z'),
      msg('m4', 'm3', 'assistant', 'four', '2024-12-03T14:00:04.000Z'),
    ]);

    const ordered = await importAll(source, env, { maxBytes: 1024 * 1024, maxItems: 2 });
    expect(ordered.map((i) => i.id)).toEqual([
      `pi:sessions/--proj--/2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl:m1`,
      `pi:sessions/--proj--/2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl:m2`,
      `pi:sessions/--proj--/2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl:m3`,
      `pi:sessions/--proj--/2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl:m4`,
    ]);
    expect(ordered.map((i) => i.createdAtMs)).toEqual([
      Date.parse('2024-12-03T14:00:01.000Z'),
      Date.parse('2024-12-03T14:00:02.000Z'),
      Date.parse('2024-12-03T14:00:03.000Z'),
      Date.parse('2024-12-03T14:00:04.000Z'),
    ]);
  });

  it('reads legacy v1 linear sessions without dropping all but the final entry', async () => {
    const agentDir = freshAgentDir();
    const legacyHeader = { type: 'session', id: SESSION_ID, timestamp: '2024-12-03T14:00:00.000Z', cwd: '/proj' };
    const legacyMessage = (role: string, text: string, ts: string) => ({
      type: 'message',
      timestamp: ts,
      message: { role, content: [{ type: 'text', text }], timestamp: Date.parse(ts) },
    });
    const { source, env } = writeSession(agentDir, [
      legacyHeader,
      legacyMessage('user', 'one', '2024-12-03T14:00:01.000Z'),
      legacyMessage('assistant', 'two', '2024-12-03T14:00:02.000Z'),
      legacyMessage('user', 'three', '2024-12-03T14:00:03.000Z'),
    ]);

    const ordered = await importAll(source, env, { maxBytes: 1024 * 1024, maxItems: 10 });
    expect(ordered).toHaveLength(3);
    expect(ordered.map((item) => item.createdAtMs)).toEqual([
      Date.parse('2024-12-03T14:00:01.000Z'),
      Date.parse('2024-12-03T14:00:02.000Z'),
      Date.parse('2024-12-03T14:00:03.000Z'),
    ]);
  });

  it('preserves modern tree links when a valid header has no version', async () => {
    const agentDir = freshAgentDir();
    const versionlessHeader = {
      type: 'session',
      id: SESSION_ID,
      timestamp: '2024-12-03T14:00:00.000Z',
      cwd: '/proj',
    };
    const { source, env } = writeSession(agentDir, [
      versionlessHeader,
      msg('m1', null, 'user', 'prompt', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'abandoned', '2024-12-03T14:00:02.000Z'),
      msg('m3', 'm1', 'assistant', 'active', '2024-12-03T14:00:03.000Z'),
    ]);

    const ordered = await importAll(source, env, { maxBytes: 1024 * 1024, maxItems: 10 });
    expect(ordered.map((item) => item.id)).toEqual([
      `pi:sessions/--proj--/2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl:m1`,
      `pi:sessions/--proj--/2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl:m3`,
    ]);
  });

  it('does not reinterpret non-missing filesystem failures as an empty session', async () => {
    const directory = freshAgentDir();
    await expect(loadPiSessionEntries(directory)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('pages only the active branch, excluding the abandoned sibling', async () => {
    const agentDir = freshAgentDir();
    const { source, env } = writeSession(agentDir, [
      header,
      msg('m1', null, 'user', 'prompt', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'abandoned branch', '2024-12-03T14:00:02.000Z'),
      msg('m3', 'm1', 'assistant', 'active branch', '2024-12-03T14:00:03.000Z'),
    ]);

    const ordered = await importAll(source, env, { maxBytes: 1024 * 1024, maxItems: 10 });
    // only m1 + m3 (active leaf = m3, the last in file)
    expect(ordered.map((i) => i.id)).toHaveLength(2);
    expect((ordered[1]!.raw as { content: { data: { message: { content: Array<{ text: string }> } } } }).content.data.message.content[0]!.text).toBe('active branch');
  });

  it('returns empty and no cursor for a missing session', async () => {
    const agentDir = freshAgentDir();
    // empty agent dir (no sessions)
    const source: DirectSessionsSource = { kind: 'piAgentDir' };
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
    const page = await pagePiTranscript({ source, env, remoteSessionId: SESSION_ID, direction: 'older', maxBytes: 1024, maxItems: 10 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  it('returns empty for the newer direction (v1 uses readAfter for tail)', async () => {
    const agentDir = freshAgentDir();
    const { source, env } = writeSession(agentDir, [header, msg('m1', null, 'user', 'one', '2024-12-03T14:00:01.000Z')]);
    const page = await pagePiTranscript({ source, env, remoteSessionId: SESSION_ID, direction: 'newer', maxBytes: 1024, maxItems: 10 });
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('honors maxItems by splitting across pages without losing items', async () => {
    const agentDir = freshAgentDir();
    const { source, env } = writeSession(agentDir, [
      header,
      msg('m1', null, 'user', '1', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', '2', '2024-12-03T14:00:02.000Z'),
      msg('m3', 'm2', 'user', '3', '2024-12-03T14:00:03.000Z'),
      msg('m4', 'm3', 'assistant', '4', '2024-12-03T14:00:04.000Z'),
      msg('m5', 'm4', 'user', '5', '2024-12-03T14:00:05.000Z'),
    ]);

    const ordered = await importAll(source, env, { maxBytes: 1024 * 1024, maxItems: 2 });
    expect(ordered).toHaveLength(5);
    expect(ordered.map((i) => i.createdAtMs)).toEqual([
      Date.parse('2024-12-03T14:00:01.000Z'),
      Date.parse('2024-12-03T14:00:02.000Z'),
      Date.parse('2024-12-03T14:00:03.000Z'),
      Date.parse('2024-12-03T14:00:04.000Z'),
      Date.parse('2024-12-03T14:00:05.000Z'),
    ]);
  });

  it('pages both rows of one bash execution without gaps when maxItems is one', async () => {
    const agentDir = freshAgentDir();
    const { source, env } = writeSession(agentDir, [
      header,
      {
        type: 'message', id: 'bash1', parentId: null, timestamp: '2024-12-03T14:00:01.000Z',
        message: {
          role: 'bashExecution', command: 'pwd', output: '/proj', exitCode: 0,
          cancelled: false, truncated: false, timestamp: Date.parse('2024-12-03T14:00:01.000Z'),
        },
      },
    ]);

    const ordered = await importAll(source, env, { maxBytes: 1024 * 1024, maxItems: 1 });
    const baseId = `pi:sessions/--proj--/2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl:bash1`;
    expect(ordered.map((item) => item.id)).toEqual([`${baseId}:bash-call`, `${baseId}:bash-result`]);
  });

  it('reconstructs chronologically with no duplicates or gaps when maxBytes truncates pages below maxItems', async () => {
    // Regression: byte-truncation must not overlap the next page's window. With small maxBytes each
    // page delivers fewer items than maxItems; the reconstruction must still be chronological,
    // gap-free, and duplicate-free across the whole active branch.
    const agentDir = freshAgentDir();
    const { source, env } = writeSession(agentDir, [
      header,
      msg('m1', null, 'user', 'message one', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'message two', '2024-12-03T14:00:02.000Z'),
      msg('m3', 'm2', 'user', 'message three', '2024-12-03T14:00:03.000Z'),
      msg('m4', 'm3', 'assistant', 'message four', '2024-12-03T14:00:04.000Z'),
      msg('m5', 'm4', 'user', 'message five', '2024-12-03T14:00:05.000Z'),
      msg('m6', 'm5', 'assistant', 'message six', '2024-12-03T14:00:06.000Z'),
    ]);

    const ordered = await importAll(source, env, { maxBytes: 512, maxItems: 10 });
    // all six, no duplicates
    expect(ordered).toHaveLength(6);
    expect(new Set(ordered.map((i) => i.id)).size).toBe(6);
    // strictly chronological
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]!.createdAtMs).toBeGreaterThanOrEqual(ordered[i - 1]!.createdAtMs);
    }
    expect(ordered.map((i) => i.id).map((id) => id.slice(-2))).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('signals truncation instead of mis-paging when the active branch changes between older-page requests', async () => {
    // A live pi session may switch its active branch (new leaf) between two older-page
    // requests. The previous page's cursor must not be applied as a bare index to the
    // re-projected branch — that would skip or duplicate entries in the imported
    // transcript. The cursor carries the boundary item id (the item the next page would
    // deliver first); when the boundary item no longer sits at that position in the new
    // active branch, the pager must report truncated (caller resets), mirroring
    // readAfterPiTranscript's anchor check.
    const agentDir = freshAgentDir();
    // Branch A: m1 -> m2 -> m3 -> m4 (active). Page 1 delivers [m3, m4], cursor boundary = m2's successor position.
    const lines = [
      header,
      msg('m1', null, 'user', 'message one', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'message two', '2024-12-03T14:00:02.000Z'),
      msg('m3', 'm2', 'assistant', 'message three', '2024-12-03T14:00:03.000Z'),
      msg('m4', 'm3', 'assistant', 'message four', '2024-12-03T14:00:04.000Z'),
    ];
    const { source, env } = writeSession(agentDir, lines);

    const first = await pagePiTranscript({ source, env, remoteSessionId: SESSION_ID, direction: 'older', maxBytes: 10_000, maxItems: 2 });
    expect(first.items.map((i) => i.id).map((id) => id.slice(-2))).toEqual(['m3', 'm4']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    // Live session diverges BELOW the boundary: the new leaf abandons m2's subtree
    // entirely (new root chain), so the boundary item m2 is no longer on the active
    // branch at all. The stale cursor's bare index must not be applied.
    const diverged = [
      header,
      msg('r1', null, 'user', 'replacement root', '2024-12-03T14:00:01.000Z'),
      msg('r2', 'r1', 'assistant', 'replacement two', '2024-12-03T14:00:02.000Z'),
      msg('r3', 'r2', 'assistant', 'replacement three', '2024-12-03T14:00:03.000Z'),
      msg('r4', 'r3', 'assistant', 'replacement four', '2024-12-03T14:00:04.000Z'),
      ];
    writeSession(agentDir, diverged);

    const second = await pagePiTranscript({ source, env, remoteSessionId: SESSION_ID, direction: 'older', cursor: first.nextCursor ?? undefined, maxBytes: 10_000, maxItems: 2 });
    expect(second.truncated).toBe(true);
    expect(second.items).toEqual([]);
  });

  it('signals truncation when the active branch changes above a shared older-page boundary', async () => {
    const agentDir = freshAgentDir();
    const branchA = [
      header,
      msg('m1', null, 'user', 'message one', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'message two', '2024-12-03T14:00:02.000Z'),
      msg('a3', 'm2', 'assistant', 'branch A three', '2024-12-03T14:00:03.000Z'),
      msg('a4', 'a3', 'assistant', 'branch A four', '2024-12-03T14:00:04.000Z'),
    ];
    const { source, env } = writeSession(agentDir, branchA);

    const first = await pagePiTranscript({
      source,
      env,
      remoteSessionId: SESSION_ID,
      direction: 'older',
      maxBytes: 10_000,
      maxItems: 2,
    });
    expect(first.items.map((item) => item.id).map((id) => id.slice(-2))).toEqual(['a3', 'a4']);
    expect(first.nextCursor).toBeTruthy();

    writeSession(agentDir, [
      header,
      msg('m1', null, 'user', 'message one', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'message two', '2024-12-03T14:00:02.000Z'),
      msg('b3', 'm2', 'assistant', 'branch B three', '2024-12-03T14:00:03.000Z'),
      msg('b4', 'b3', 'assistant', 'branch B four', '2024-12-03T14:00:04.000Z'),
    ]);

    const second = await pagePiTranscript({
      source,
      env,
      remoteSessionId: SESSION_ID,
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 10_000,
      maxItems: 2,
    });
    expect(second.truncated).toBe(true);
    expect(second.items).toEqual([]);
  });

  it('keeps paging the original snapshot when the active branch only appends', async () => {
    const agentDir = freshAgentDir();
    const initial = [
      header,
      msg('m1', null, 'user', 'message one', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'message two', '2024-12-03T14:00:02.000Z'),
      msg('m3', 'm2', 'assistant', 'message three', '2024-12-03T14:00:03.000Z'),
      msg('m4', 'm3', 'assistant', 'message four', '2024-12-03T14:00:04.000Z'),
    ];
    const { source, env } = writeSession(agentDir, initial);
    const first = await pagePiTranscript({
      source,
      env,
      remoteSessionId: SESSION_ID,
      direction: 'older',
      maxBytes: 10_000,
      maxItems: 2,
    });

    writeSession(agentDir, [
      ...initial,
      msg('m5', 'm4', 'user', 'message five', '2024-12-03T14:00:05.000Z'),
    ]);
    const second = await pagePiTranscript({
      source,
      env,
      remoteSessionId: SESSION_ID,
      direction: 'older',
      cursor: first.nextCursor ?? undefined,
      maxBytes: 10_000,
      maxItems: 2,
    });

    expect(second.truncated).not.toBe(true);
    expect(second.items.map((item) => item.id).map((id) => id.slice(-2))).toEqual(['m1', 'm2']);
  });
});
