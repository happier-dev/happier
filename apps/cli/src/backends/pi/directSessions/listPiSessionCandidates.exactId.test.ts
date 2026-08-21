import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DirectSessionsSource } from '@happier-dev/protocol';

const trackedFs = vi.hoisted(() => ({
  openedPaths: [] as string[],
  mtimeMsByPath: new Map<string, number>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      trackedFs.openedPaths.push(String(args[0]));
      return actual.open(...args);
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const result = await actual.stat(...args);
      const mtimeMs = trackedFs.mtimeMsByPath.get(String(args[0]));
      if (mtimeMs !== undefined) {
        Object.defineProperty(result, 'mtimeMs', { value: mtimeMs });
      }
      return result;
    },
  };
});

import { listPiSessionCandidates } from './listPiSessionCandidates';
import { resolvePiDirectSessionFile } from './resolvePiDirectSessionFile';

const SESSION_A = '019f4a42-4617-767a-8e7c-189b454a0352';
const SESSION_B = '019f53a6-c8cf-7a8c-a165-61d0dc6b42e7';
const tempAgentDirs = new Set<string>();

function makeAgentDir(prefix: string): string {
  const agentDir = mkdtempSync(join(tmpdir(), prefix));
  tempAgentDirs.add(agentDir);
  return agentDir;
}

function writeSession(
  agentDir: string,
  dirName: string,
  sessionId: string,
  fileName = `${sessionId}.jsonl`,
  headerSessionId = sessionId,
): string {
  const sessionsDir = join(agentDir, 'sessions', dirName);
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, fileName);
  writeFileSync(filePath, [
    JSON.stringify({ type: 'session', id: headerSessionId, timestamp: '2024-12-03T14:00:00.000Z', cwd: `/${dirName}`, version: 3 }),
    JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2024-12-03T14:00:01.000Z', message: { role: 'user', content: sessionId } }),
  ].join('\n') + '\n');
  return filePath;
}

describe('listPiSessionCandidates exact-id lookup', () => {
  beforeEach(() => {
    trackedFs.openedPaths.length = 0;
    trackedFs.mtimeMsByPath.clear();
  });

  afterEach(() => {
    for (const agentDir of tempAgentDirs) {
      rmSync(agentDir, { recursive: true, force: true });
    }
    tempAgentDirs.clear();
  });

  it('performs only the canonical resolver scan for a bare session id', async () => {
    const agentDir = makeAgentDir('pi-list-exact-id-');
    writeSession(agentDir, '--proj-a--', SESSION_A);
    writeSession(agentDir, '--proj-b--', SESSION_B);
    const source: DirectSessionsSource = { kind: 'piAgentDir' };
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };

    const result = await listPiSessionCandidates({ source, env, limit: 10, searchTerm: SESSION_A });

    expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([SESSION_A]);
    // Exact lookup may inspect the target more than once to build its title, but it must not
    // repeat the resolver's scan of unrelated headers through full candidate discovery.
    expect(trackedFs.openedPaths.filter((path) => path.endsWith(`${SESSION_B}.jsonl`))).toHaveLength(1);
  });

  it('resolves a canonical session id when the stored header contains surrounding whitespace', async () => {
    const agentDir = makeAgentDir('pi-resolve-trimmed-id-');
    const filePath = writeSession(
      agentDir,
      '--proj-a--',
      SESSION_A,
      `${SESSION_A}.jsonl`,
      `  ${SESSION_A}  `,
    );
    const source: DirectSessionsSource = { kind: 'piAgentDir' };
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };

    const resolved = await resolvePiDirectSessionFile({ source, env, remoteSessionId: SESSION_A });

    expect(resolved?.filePath).toBe(filePath);
  });

  it('uses full mtime precision when choosing between copied session ids', async () => {
    const agentDir = makeAgentDir('pi-resolve-fractional-mtime-');
    const newerPath = writeSession(agentDir, '--proj-new--', SESSION_A, 'new-copy.jsonl');
    const olderPath = writeSession(agentDir, '--proj-old--', SESSION_A, 'old-copy.jsonl');
    trackedFs.mtimeMsByPath.set(newerPath, 1_000.9);
    trackedFs.mtimeMsByPath.set(olderPath, 1_000.5);
    const source: DirectSessionsSource = { kind: 'piAgentDir' };
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };

    const resolved = await resolvePiDirectSessionFile({ source, env, remoteSessionId: SESSION_A });

    expect(resolved).toMatchObject({
      filePath: newerPath,
      header: { cwd: '/--proj-new--' },
    });
  });
});
