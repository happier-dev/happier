import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupRegisteredOpenCodeManagedServerHomesBestEffort,
  registerOpenCodeManagedServerHomeForCleanup,
} from './opencodeManagedServerCleanupRegistry';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('opencodeManagedServerCleanupRegistry', () => {
  const childPids: number[] = [];

  afterEach(async () => {
    await cleanupRegisteredOpenCodeManagedServerHomesBestEffort();
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

  async function createManagedServerHome(prefix: string): Promise<{ homeDir: string; pid: number }> {
    const homeDir = await mkdtemp(join(tmpdir(), prefix));
    const opencodeDir = join(homeDir, 'opencode');
    await mkdir(opencodeDir, { recursive: true });

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    if (!child.pid) throw new Error('Failed to spawn child process');
    child.unref();
    childPids.push(child.pid);

    await writeFile(
      join(opencodeDir, 'managed-server.json'),
      JSON.stringify({ baseUrl: 'http://127.0.0.1:0', pid: child.pid, startedAtMs: Date.now() }),
      'utf8',
    );

    return { homeDir, pid: child.pid };
  }

  it('only cleans up registered homes', async () => {
    const owned = await createManagedServerHome('happier-opencode-owned-');
    const unowned = await createManagedServerHome('happier-opencode-unowned-');

    registerOpenCodeManagedServerHomeForCleanup(owned.homeDir);

    await cleanupRegisteredOpenCodeManagedServerHomesBestEffort();

    expect(isProcessAlive(owned.pid)).toBe(false);
    expect(isProcessAlive(unowned.pid)).toBe(true);
  });

  it('does not clean up homes after unregistering them', async () => {
    const owned = await createManagedServerHome('happier-opencode-unregister-');

    const unregister = registerOpenCodeManagedServerHomeForCleanup(owned.homeDir);
    unregister();

    await cleanupRegisteredOpenCodeManagedServerHomesBestEffort();

    expect(isProcessAlive(owned.pid)).toBe(true);
  });
});
