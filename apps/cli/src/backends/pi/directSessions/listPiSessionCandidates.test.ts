import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import {
  listPiSessionCandidates,
  resolvePiDiscoveryConcurrencyBudget,
} from './listPiSessionCandidates';

const SESSION_A = '019f4a42-4617-767a-8e7c-189b454a0352';
const SESSION_B = '019f53a6-c8cf-7a8c-a165-61d0dc6b42e7';

function writeSession(agentDir: string, dirName: string, fileName: string, lines: readonly object[], mtimeSeconds: number): void {
  const sessionsDir = join(agentDir, 'sessions', dirName);
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, fileName);
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  utimesSync(filePath, mtimeSeconds, mtimeSeconds);
}

function sourceEnv(agentDir: string): { source: DirectSessionsSource; env: NodeJS.ProcessEnv } {
  return { source: { kind: 'piAgentDir' }, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } };
}

function header(id: string, cwd: string): object {
  return { type: 'session', id, timestamp: '2024-12-03T14:00:00.000Z', cwd, version: 3 };
}

function userMsg(id: string, parentId: string | null, text: string): object {
  return { type: 'message', id, parentId, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: text } };
}

describe('listPiSessionCandidates', () => {
  it('keeps nested directory and file work inside one discovery concurrency budget', () => {
    const budget = resolvePiDiscoveryConcurrencyBudget(64);

    expect(budget.directoryConcurrency).toBeGreaterThan(0);
    expect(budget.fileConcurrency).toBeGreaterThan(0);
    expect(budget.directoryConcurrency * budget.fileConcurrency).toBeLessThanOrEqual(64);
  });

  it('discovers sessions across cwd-encoded directories, sorted by mtime descending', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-'));
    writeSession(agentDir, '--proj-a--', `2024-12-03T14-00-00-000Z_${SESSION_A}.jsonl`, [header(SESSION_A, '/proj-a'), userMsg('m1', null, 'task in proj-a')], 1_700_000_100);
    writeSession(agentDir, '--proj-b--', `2024-12-04T09-00-00-000Z_${SESSION_B}.jsonl`, [header(SESSION_B, '/proj-b'), userMsg('n1', null, 'task in proj-b')], 1_700_000_200);

    const { source, env } = sourceEnv(agentDir);
    const result = await listPiSessionCandidates({ source, env, limit: 10 });

    expect(result.candidates.map((c) => c.remoteSessionId)).toEqual([SESSION_B, SESSION_A]);
    expect(result.nextCursor).toBeNull();
    // title + cwd enriched from header/title scan
    const candidateA = result.candidates.find((c) => c.remoteSessionId === SESSION_A)!;
    expect(candidateA.title).toBe('task in proj-a');
    expect((candidateA.details as { cwd: string }).cwd).toBe('/proj-a');
  });

  it('paginates with an index cursor', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-page-'));
    writeSession(agentDir, '--proj-a--', `2024-12-03T14-00-00-000Z_${SESSION_A}.jsonl`, [header(SESSION_A, '/proj-a'), userMsg('m1', null, 'older')], 1_700_000_100);
    writeSession(agentDir, '--proj-b--', `2024-12-04T09-00-00-000Z_${SESSION_B}.jsonl`, [header(SESSION_B, '/proj-b'), userMsg('n1', null, 'newer')], 1_700_000_200);

    const { source, env } = sourceEnv(agentDir);
    const first = await listPiSessionCandidates({ source, env, limit: 1 });
    expect(first.candidates.map((c) => c.remoteSessionId)).toEqual([SESSION_B]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listPiSessionCandidates({ source, env, limit: 1, cursor: first.nextCursor! });
    expect(second.candidates.map((c) => c.remoteSessionId)).toEqual([SESSION_A]);
    expect(second.nextCursor).toBeNull();
  });

  it('exact-id search resolves directly to the session regardless of scan order', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-search-'));
    writeSession(agentDir, '--proj-a--', `2024-12-03T14-00-00-000Z_${SESSION_A}.jsonl`, [header(SESSION_A, '/proj-a'), userMsg('m1', null, 'find me')], 1_700_000_100);
    writeSession(agentDir, '--proj-b--', `2024-12-04T09-00-00-000Z_${SESSION_B}.jsonl`, [header(SESSION_B, '/proj-b'), userMsg('n1', null, 'other')], 1_700_000_200);

    const { source, env } = sourceEnv(agentDir);
    const result = await listPiSessionCandidates({ source, env, limit: 10, searchTerm: SESSION_A });
    expect(result.candidates.map((c) => c.remoteSessionId)).toEqual([SESSION_A]);
    expect(result.candidates[0]!.title).toBe('find me');
    expect(result.candidates[0]!.details).toEqual({
      cwd: '/proj-a',
      sessionDirName: '--proj-a--',
    });
  });

  it('uses the header id when a valid session file has been renamed', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-renamed-'));
    writeSession(agentDir, '--proj-a--', 'copied-session.jsonl', [header(SESSION_A, '/proj-a'), userMsg('m1', null, 'renamed')], 1_700_000_100);

    const { source, env } = sourceEnv(agentDir);
    const listed = await listPiSessionCandidates({ source, env, limit: 10 });
    expect(listed.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([SESSION_A]);

    const exact = await listPiSessionCandidates({ source, env, limit: 10, searchTerm: SESSION_A });
    expect(exact.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([SESSION_A]);
  });

  it('does not list files without a valid canonical session header', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-invalid-header-'));
    writeSession(agentDir, '--proj-a--', `2024-12-03T14-00-00-000Z_${SESSION_A}.jsonl`, [
      userMsg('m1', null, 'missing header'),
    ], 1_700_000_100);

    const { source, env } = sourceEnv(agentDir);
    const listed = await listPiSessionCandidates({ source, env, limit: 10 });

    expect(listed.candidates).toEqual([]);
  });

  it('consolidates copied files with the same header id onto the newest resolvable session', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-copied-'));
    writeSession(agentDir, '--proj-old--', 'old-copy.jsonl', [
      header(SESSION_A, '/proj-old'),
      userMsg('m1', null, 'older copy'),
    ], 1_700_000_100);
    writeSession(agentDir, '--proj-new--', 'new-copy.jsonl', [
      header(SESSION_A, '/proj-new'),
      userMsg('n1', null, 'newer copy'),
    ], 1_700_000_200);

    const { source, env } = sourceEnv(agentDir);
    const listed = await listPiSessionCandidates({ source, env, limit: 10 });

    expect(listed.candidates).toHaveLength(1);
    expect(listed.candidates[0]).toMatchObject({
      remoteSessionId: SESSION_A,
      title: 'newer copy',
      details: { cwd: '/proj-new', sessionDirName: '--proj-new--' },
    });
  });

  it('terminates full search pagination when no candidates match', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-no-match-'));
    writeSession(agentDir, '--proj-a--', `2024-12-03T14-00-00-000Z_${SESSION_A}.jsonl`, [header(SESSION_A, '/proj-a'), userMsg('m1', null, 'alpha')], 1_700_000_100);

    const { source, env } = sourceEnv(agentDir);
    const result = await listPiSessionCandidates({ source, env, limit: 10, searchTerm: 'does-not-exist', searchMode: 'full' });
    expect(result.candidates).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns an empty candidate list when the agent dir has no sessions', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-empty-'));
    const { source, env } = sourceEnv(agentDir);
    const result = await listPiSessionCandidates({ source, env, limit: 10 });
    expect(result.candidates).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});
