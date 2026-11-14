import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Real filesystem; session-file opens and full inspections (head reads at
// offset 0 longer than one record) are counted to prove Browse inspects only
// the rows it serves.
const fsProbe = vi.hoisted(() => ({ sessionOpens: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]).endsWith('.jsonl')) fsProbe.sessionOpens += 1;
      return await actual.open(...args);
    },
  };
});

const { createPiExternalSessionsContribution } = await import('./contribution.js');

const roots = new Set<string>();
afterEach(async () => {
  await Promise.all([...roots].map(async (root) => await rm(root, { recursive: true, force: true })));
  roots.clear();
});

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function invocation() {
  return { signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000, maxSerializedBytes: 64 * 1024 };
}

describe('Pi Browse in activity order', () => {
  it('serves the newest sessions by last record time and inspects only the page rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-activity-'));
    roots.add(root);
    const agentDir = join(root, '.pi', 'agent');
    const sessionRoot = join(agentDir, 'sessions', '--workspace--');
    await mkdir(sessionRoot, { recursive: true });
    const count = 120;
    const base = Date.UTC(2026, 0, 1);
    for (let index = 0; index < count; index += 1) {
      // Created in index order; the first created was active most recently.
      const id = `pi-${String(index).padStart(3, '0')}`;
      const createdAt = new Date(base + index * 1_000).toISOString();
      const lastAt = new Date(base + 10_000_000 + (count - index) * 60_000).toISOString();
      await writeFile(join(sessionRoot, `${createdAt.replaceAll(':', '-')}_${id}.jsonl`), [
        line({ type: 'session', version: 3, id, timestamp: createdAt, cwd: '/workspace' }),
        line({ type: 'message', id: `${id}-user`, parentId: null, timestamp: createdAt, message: { role: 'user', content: `prompt ${id}` } }),
        line({ type: 'session_info', id: `${id}-title`, parentId: `${id}-user`, timestamp: lastAt, name: `title ${index}` }),
      ].join(''), 'utf8');
    }
    const contribution = createPiExternalSessionsContribution({ env: { PI_CODING_AGENT_DIR: agentDir } });
    const source = { kind: 'piAgentDir' as const };
    fsProbe.sessionOpens = 0;
    const first = await contribution.listCandidates({ ...invocation(), source, maxItems: 10 });
    if (!first.ok || !first.value.nextCursor) throw new Error(JSON.stringify(first));
    const firstOpens = fsProbe.sessionOpens;
    expect({
      ids: first.value.candidates.map((candidate) => candidate.remoteSessionId),
      titles: first.value.candidates.map((candidate) => candidate.title),
    }).toEqual({
      ids: Array.from({ length: 10 }, (_, index) => `pi-${String(index).padStart(3, '0')}`),
      titles: Array.from({ length: 10 }, (_, index) => `title ${index}`),
    });
    expect(first.value).not.toHaveProperty('preparation');
    // One tail read per session for its activity time, plus the full
    // inspection (header, head/tail scan) of only the 10 served rows.
    expect(firstOpens).toBe(count + 3 * 10);
    const second = await contribution.listCandidates({ ...invocation(), source, maxItems: 10, cursor: first.value.nextCursor });
    if (!second.ok) throw new Error(JSON.stringify(second));
    expect(second.value.candidates.map((candidate) => candidate.remoteSessionId))
      .toEqual(Array.from({ length: 10 }, (_, index) => `pi-${String(index + 10).padStart(3, '0')}`));
    expect(second.value).not.toHaveProperty('preparation');
    expect(second.value.candidates[0]?.updatedAtMs).toBe(base + 10_000_000 + (count - 10) * 60_000);
  });
});
