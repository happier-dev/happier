import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { listOhMyPiSessionCandidates } from './candidates.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(async () => {
      throw new Error('full-file read is forbidden during candidate discovery');
    }),
  };
});

const tempDirs = new Set<string>();

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  vi.mocked(readFile).mockClear();
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe('listOhMyPiSessionCandidates', () => {
  it('discovers candidates with bounded scanner reads and header-authoritative ids', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-candidates-'));
    tempDirs.add(agentDir);
    const sessionRoot = join(agentDir, 'sessions', '-repo');
    await mkdir(sessionRoot, { recursive: true });
    const filePath = join(sessionRoot, 'a_b_c.jsonl');
    await writeFile(filePath, [
      jsonlLine({
        type: 'session',
        id: 'c',
        timestamp: '2026-04-10T10:00:00.000Z',
        cwd: '/repo',
        title: 'Header title',
      }),
      jsonlLine({
        type: 'message',
        id: 'user-1',
        timestamp: '2026-04-10T10:00:01.000Z',
        message: { role: 'user', content: 'hello' },
      }),
      jsonlLine({
        type: 'session_info',
        name: 'Tail title',
        timestamp: '2026-04-10T10:00:02.000Z',
      }),
    ].join(''), 'utf8');
    const canonicalAgentDir = await realpath(agentDir);

    const result = await listOhMyPiSessionCandidates({
      source: { kind: 'ohMyPiAgentDir', agentDir },
      env: {},
      limit: 10,
    });

    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([
      expect.objectContaining({
        remoteSessionId: 'c',
        title: 'Tail title',
        createdAtMs: Date.parse('2026-04-10T10:00:00.000Z'),
        details: expect.objectContaining({
          workingDirectory: '/repo',
          agentDir: canonicalAgentDir,
        }),
      }),
    ]);
    expect(result.candidates[0]?.remoteSessionId).not.toBe('b_c');
  });
});
