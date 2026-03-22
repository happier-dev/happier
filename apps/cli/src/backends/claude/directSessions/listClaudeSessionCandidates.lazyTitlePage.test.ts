import { mkdir, mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const openMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => openMock(...args),
    stat: (...args: Parameters<typeof actual.stat>) => statMock(...args),
  };
});

import { listClaudeSessionCandidates } from './listClaudeSessionCandidates';

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe('listClaudeSessionCandidates lazy title reads', () => {
  beforeEach(async () => {
    openMock.mockReset();
    statMock.mockReset();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    openMock.mockImplementation(actual.open);
    statMock.mockImplementation(actual.stat);
  });

  it('does not block the first page on title reads for later non-page sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-list-lazy-'));
    const configDir = join(root, '.claude');
    const projectDir = join(configDir, 'projects', 'proj-a');
    await mkdir(projectDir, { recursive: true });

    const fastFile = join(projectDir, 'sess-fast.jsonl');
    const stuckFile = join(projectDir, 'sess-stuck.jsonl');

    await writeFile(
      fastFile,
      jsonlLine({ type: 'summary', leafUuid: 'leaf-fast', summary: 'Fast Claude title' }),
      'utf8',
    );
    await writeFile(
      stuckFile,
      jsonlLine({ type: 'summary', leafUuid: 'leaf-stuck', summary: 'Stuck Claude title' }),
      'utf8',
    );

    await utimes(fastFile, new Date('2026-03-06T12:00:00.000Z'), new Date('2026-03-06T12:00:00.000Z'));
    await utimes(stuckFile, new Date('2026-03-05T12:00:00.000Z'), new Date('2026-03-05T12:00:00.000Z'));

    openMock.mockImplementation(async (filePath, flags) => {
      if (String(filePath).endsWith('sess-stuck.jsonl')) {
        return await new Promise<never>(() => {});
      }
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.open(filePath, flags);
    });

    const result = await Promise.race([
      listClaudeSessionCandidates({
        source: { kind: 'claudeConfig', configDir, projectId: null },
        env: {} as NodeJS.ProcessEnv,
        limit: 1,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for first Claude page')), 250)),
    ]);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.remoteSessionId).toBe('sess-fast');
    expect(result.candidates[0]?.title).toBe('Fast Claude title');
  });

  it('starts session metadata stats concurrently instead of serializing every file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-direct-list-concurrent-'));
    const configDir = join(root, '.claude');
    const projectDir = join(configDir, 'projects', 'proj-a');
    await mkdir(projectDir, { recursive: true });

    const newestFile = join(projectDir, 'sess-newest.jsonl');
    const olderFile = join(projectDir, 'sess-older.jsonl');
    const oldestFile = join(projectDir, 'sess-oldest.jsonl');

    await writeFile(newestFile, jsonlLine({ type: 'summary', leafUuid: 'leaf-newest', summary: 'Newest Claude title' }), 'utf8');
    await writeFile(olderFile, jsonlLine({ type: 'summary', leafUuid: 'leaf-older', summary: 'Older Claude title' }), 'utf8');
    await writeFile(oldestFile, jsonlLine({ type: 'summary', leafUuid: 'leaf-oldest', summary: 'Oldest Claude title' }), 'utf8');

    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const pendingResolvers: Array<() => void> = [];
    let startedStats = 0;

    statMock.mockImplementation(async (filePath) => {
      if (!String(filePath).endsWith('.jsonl')) {
        return actual.stat(filePath);
      }

      startedStats += 1;
      await new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
        if (startedStats >= 3) {
          for (const release of pendingResolvers.splice(0)) {
            release();
          }
        }
      });

      if (String(filePath).endsWith('sess-newest.jsonl')) {
        return { mtimeMs: Date.parse('2026-03-06T12:00:00.000Z') } as Awaited<ReturnType<typeof actual.stat>>;
      }
      if (String(filePath).endsWith('sess-older.jsonl')) {
        return { mtimeMs: Date.parse('2026-03-05T12:00:00.000Z') } as Awaited<ReturnType<typeof actual.stat>>;
      }
      return { mtimeMs: Date.parse('2026-03-04T12:00:00.000Z') } as Awaited<ReturnType<typeof actual.stat>>;
    });

    const result = await Promise.race([
      listClaudeSessionCandidates({
        source: { kind: 'claudeConfig', configDir, projectId: null },
        env: {} as NodeJS.ProcessEnv,
        limit: 1,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after starting ${startedStats} Claude stat call(s)`)), 250)),
    ]);

    expect(startedStats).toBeGreaterThanOrEqual(3);
    expect(result.candidates[0]?.remoteSessionId).toBe('sess-newest');
  });
});
