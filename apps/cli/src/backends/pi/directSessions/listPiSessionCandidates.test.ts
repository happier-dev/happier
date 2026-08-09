import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DirectSessionsSource } from '@happier-dev/protocol';

import { listPiSessionCandidates } from './listPiSessionCandidates';

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
  });

  it('returns an empty candidate list when the agent dir has no sessions', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-list-empty-'));
    const { source, env } = sourceEnv(agentDir);
    const result = await listPiSessionCandidates({ source, env, limit: 10 });
    expect(result.candidates).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});
