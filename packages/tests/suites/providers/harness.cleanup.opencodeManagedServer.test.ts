import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { stopOpenCodeManagedServerFromHomeDir } from '../../src/testkit/providers/opencode/stopOpenCodeManagedServerFromHomeDir';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('provider harness cleanup: OpenCode managed server state', () => {
  const childPids: number[] = [];

  afterEach(async () => {
    for (const pid of childPids.splice(0, childPids.length)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  });

  it('kills the managed server pid referenced by happyHomeDir/opencode/managed-server.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-tests-opencode-managed-'));
    const opencodeDir = join(home, 'opencode');
    await mkdir(opencodeDir, { recursive: true });

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('Failed to spawn child process');
    child.unref();
    childPids.push(child.pid);

    const statePath = join(opencodeDir, 'managed-server.json');
    await writeFile(
      statePath,
      JSON.stringify({ baseUrl: 'http://127.0.0.1:0', pid: child.pid, startedAtMs: Date.now() }),
      'utf8',
    );

    expect(isProcessAlive(child.pid)).toBe(true);

    await stopOpenCodeManagedServerFromHomeDir(home);

    expect(isProcessAlive(child.pid)).toBe(false);
  });
});

