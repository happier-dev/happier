import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stopDaemonFromHomeDir } from '../../src/testkit/daemon/daemon';

async function withDaemonState<T>(
  run: (homeDir: string) => Promise<T>,
  state: { pid: number; httpPort: number },
): Promise<T> {
  const homeDir = await mkdtemp(join(tmpdir(), 'daemon-stop-test-'));
  try {
    await writeFile(join(homeDir, 'daemon.state.json'), JSON.stringify(state), 'utf8');
    return await run(homeDir);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stopDaemonFromHomeDir failure context', () => {
  it('includes unreachable phase context when daemon stop endpoint cannot be reached', async () => {
    await withDaemonState(
      async (homeDir) => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            throw new Error('network down');
          }),
        );
        vi.spyOn(process, 'kill').mockImplementation(() => true);

        await expect(
          stopDaemonFromHomeDir(homeDir, {
            inspectProcess: () => ({ ok: false, reason: 'ps_missing' }),
          }),
        ).rejects.toThrow(/phase=unreachable/);
      },
      { pid: 999_001, httpPort: 31_010 },
    );
  });

  it('includes graceful-timeout phase context when hard-kill safety checks fail', async () => {
    await withDaemonState(
      async (homeDir) => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
        vi.spyOn(process, 'kill').mockImplementation(() => true);

        await expect(
          stopDaemonFromHomeDir(homeDir, {
            gracefulTimeoutMs: 1,
            inspectProcess: () => ({
              ok: true,
              command: 'node some-other-process.js',
              looksLikeDaemon: false,
            }),
          }),
        ).rejects.toThrow(/phase=graceful-timeout/);
      },
      { pid: 999_002, httpPort: 31_011 },
    );
  });
});
