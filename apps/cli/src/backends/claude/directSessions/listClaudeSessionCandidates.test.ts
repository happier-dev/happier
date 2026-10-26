import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const readdirMock = vi.hoisted(() => vi.fn<typeof import('node:fs/promises').readdir>());

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readdir: (...args: Parameters<typeof actual.readdir>) => readdirMock(...args) };
});

import { listClaudeSessionCandidates } from './listClaudeSessionCandidates';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('listClaudeSessionCandidates', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    readdirMock.mockReset();
    readdirMock.mockImplementation(actual.readdir);
  });

  it('shares one in-flight listing for identical concurrent calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-list-inflight-'));
    const configDir = join(root, '.claude');
    await mkdir(join(configDir, 'projects', 'proj-a'), { recursive: true });
    await writeFile(join(configDir, 'projects', 'proj-a', 'sess-1.jsonl'), jsonlLine({ type: 'user', message: { content: 'hello' } }), 'utf8');
    const projectsDir = join(configDir, 'projects');
    const discoveryScans = () => readdirMock.mock.calls.filter(([path]) => String(path) === projectsDir).length;
    const request = { source: { kind: 'claudeConfig', configDir, projectId: null }, limit: 10 } as const;

    const [first, second] = await Promise.all([listClaudeSessionCandidates(request), listClaudeSessionCandidates({ ...request })]);
    expect(first).toEqual(second);
    expect(first.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['sess-1']);
    expect(first.candidates[0]?.title).toBe('hello');
    expect(discoveryScans()).toBe(1);

    await Promise.all([
      listClaudeSessionCandidates(request),
      listClaudeSessionCandidates({ ...request, limit: 5 }),
    ]);
    expect(discoveryScans()).toBe(3);

    await Promise.all([
      listClaudeSessionCandidates({ ...request, env: {} }),
      listClaudeSessionCandidates({ ...request, env: { HAPPIER_DIRECT_SESSIONS_CLAUDE_DISCOVERY_CONCURRENCY: '1' } }),
    ]);
    expect(discoveryScans()).toBe(5);

    await listClaudeSessionCandidates(request);
    expect(discoveryScans()).toBe(6);
  });

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

  it('matches search terms against surfaced session titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-title-search-'));
    const configDir = join(root, '.claude');
    const project = join(configDir, 'projects', 'proj-unrelated');
    await mkdir(project, { recursive: true });

    const matchingFile = join(project, 'sess-a.jsonl');
    const otherFile = join(project, 'sess-b.jsonl');

    await writeFile(
      matchingFile,
      jsonlLine({ type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'Investigate daemon-backed browse search' }] } }),
      'utf8',
    );
    await writeFile(
      otherFile,
      jsonlLine({ type: 'user', uuid: 'u2', message: { content: [{ type: 'text', text: 'Unrelated planning note' }] } }),
      'utf8',
    );

    await utimes(matchingFile, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));
    await utimes(otherFile, new Date('2026-01-04T00:00:00.000Z'), new Date('2026-01-04T00:00:00.000Z'));

    const result = await listClaudeSessionCandidates({
      source: { kind: 'claudeConfig', configDir, projectId: null },
      env: {} as NodeJS.ProcessEnv,
      searchTerm: 'daemon-backed',
      limit: 10,
    });

    expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['sess-a']);
    expect(result.candidates[0]?.title).toBe('Investigate daemon-backed browse search');
    expect(result.nextCursor).toBeNull();
  });
});
