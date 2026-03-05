import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listCodexSessionCandidates } from './listCodexSessionCandidates';

function sessionMetaLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'session_meta', payload })}\n`;
}

function responseItemLine(payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: 'response_item', payload })}\n`;
}

describe('listCodexSessionCandidates', () => {
  it('lists sessions from CODEX_HOME with archived flags and paging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-direct-list-'));
    const codexHome = join(root, 'codex-home');
    const sessionsDir = join(codexHome, 'sessions');
    const archivedDir = join(codexHome, 'archived_sessions');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });

    const session1 = '11111111-1111-1111-1111-111111111111';
    const session2 = '22222222-2222-2222-2222-222222222222';

    const s1a = join(sessionsDir, `rollout-2026-01-01T00-00-00-${session1}.jsonl`);
    const s1b = join(sessionsDir, `rollout-2026-01-02T00-00-00-${session1}.jsonl`);
    const s2 = join(archivedDir, `rollout-2026-01-03T00-00-00-${session2}.jsonl`);

    await writeFile(
      s1a,
      sessionMetaLine({ id: session1, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/repo/one' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] }),
      'utf8',
    );
    await writeFile(
      s1b,
      sessionMetaLine({ id: session1, timestamp: '2026-01-02T00:00:00.000Z', cwd: '/repo/one' })
        + responseItemLine({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'world' }] }),
      'utf8',
    );
    await writeFile(
      s2,
      sessionMetaLine({ id: session2, timestamp: '2026-01-03T00:00:00.000Z', cwd: '/repo/two' })
        + responseItemLine({ type: 'message', role: 'user', content: [{ type: 'text', text: 'archived' }] }),
      'utf8',
    );

    await utimes(s1a, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(s1b, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));
    await utimes(s2, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));

    const first = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      limit: 1,
    });

    expect(first.candidates.length).toBe(1);
    expect(first.candidates[0]?.remoteSessionId).toBe(session2);
    expect(first.candidates[0]?.archived).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      activeServerDir: join(root, 'servers', 'cloud'),
      cursor: first.nextCursor ?? undefined,
      limit: 10,
    });

    expect(second.candidates.map((c) => c.remoteSessionId)).toEqual([session1]);
    expect(second.candidates[0]?.archived).toBe(false);
    expect(second.nextCursor).toBeNull();
  });
});

