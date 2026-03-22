import { describe, expect, it } from 'vitest';

import { isProcessAlive, terminateProcessTreeByPid } from './processTree';
import { spawnDetachedInlineNodeTestProcess, spawnTestProcess } from './testSpawn';

describe('testSpawn', () => {
  it('spawns a child process and exposes its pid', async () => {
    const child = spawnTestProcess(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });

    expect(child.pid).toBeTypeOf('number');

    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        expect(code).toBe(0);
        resolve();
      });
    });
  });

  it('spawns detached inline node processes', async () => {
    const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const pid = child.pid;

    expect(pid).toBeTypeOf('number');
    expect(isProcessAlive(pid!)).toBe(true);

    await terminateProcessTreeByPid(pid!, { graceMs: 0, pollMs: 25 }).catch(() => {});
    expect(isProcessAlive(pid!)).toBe(false);
  });
});
