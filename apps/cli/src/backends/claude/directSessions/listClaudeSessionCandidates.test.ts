import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listClaudeSessionCandidates } from './listClaudeSessionCandidates';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('listClaudeSessionCandidates', () => {
  it('lists session jsonl files under ~/.claude/projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-list-'));
    const configDir = join(root, '.claude');
    const projectsDir = join(configDir, 'projects');
    const projectA = join(projectsDir, 'proj-a');
    const projectB = join(projectsDir, 'proj-b');
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });

    const file1 = join(projectA, 'sess-1.jsonl');
    const file2 = join(projectB, 'sess-2.jsonl');

    await writeFile(
      file1,
      jsonlLine({ type: 'summary', leafUuid: 'leaf-1', summary: 'Claude session one' })
        + jsonlLine({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'hi' }] } }),
      'utf8',
    );
    await writeFile(
      file2,
      jsonlLine({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: 'Ship the dropdown redesign for browse sessions' }] } }),
      'utf8',
    );

    await utimes(file1, new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:00.000Z'));
    await utimes(file2, new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'));

    const first = await listClaudeSessionCandidates({
      source: { kind: 'claudeConfig', configDir, projectId: null },
      env: {} as NodeJS.ProcessEnv,
      limit: 1,
    });

    expect(first.candidates).toHaveLength(1);
    expect(first.candidates[0]?.remoteSessionId).toBe('sess-2');
    expect(first.candidates[0]?.title).toBe('Ship the dropdown redesign for browse sessions');
    expect(first.candidates[0]?.activity).toBe('idle');
    expect((first.candidates[0]?.details as any)?.projectId).toBe('proj-b');
    expect(first.nextCursor).toBeTruthy();

    const second = await listClaudeSessionCandidates({
      source: { kind: 'claudeConfig', configDir, projectId: null },
      env: {} as NodeJS.ProcessEnv,
      cursor: first.nextCursor ?? undefined,
      limit: 10,
    });
    expect(second.candidates.map((c) => c.remoteSessionId)).toEqual(['sess-1']);
    expect(second.candidates[0]?.title).toBe('Claude session one');
    expect(second.candidates[0]?.activity).toBe('idle');
    expect(second.nextCursor).toBeNull();
  });
});
