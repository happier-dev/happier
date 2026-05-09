import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { isProcessAlive, terminateProcessTreeByPid } from './processTree';
import { spawnDetachedInlineNodeTestProcess, spawnDetachedTestProcess, spawnTestProcess } from './testSpawn';
import { resolveTsxImportHookSpecifier } from './tsxImportHook';
import { repoRootDir } from '../paths';

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

  it('terminateProcessTreeByPid does not SIGTERM the caller when the target shares its process group', async () => {
    const tsxHookSpecifier = resolveTsxImportHookSpecifier();
    if (!tsxHookSpecifier) {
      throw new Error('tsx import hook is required for processTree regression coverage but could not be resolved');
    }

    const child = spawnDetachedTestProcess(
      process.execPath,
      [
        '--import',
        tsxHookSpecifier,
        '--input-type=module',
        '-e',
        [
          "import { spawn } from 'node:child_process';",
          "import { terminateProcessTreeByPid } from './packages/tests/src/testkit/process/processTree.ts';",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          "if (!child.pid) throw new Error('Failed to spawn child process');",
          'await terminateProcessTreeByPid(child.pid, { graceMs: 0, pollMs: 25 });',
          'process.exit(0);',
          '',
        ].join('\n'),
      ],
      {
        cwd: repoRootDir(),
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );

    try {
      const [code, signal] = await Promise.race([
        once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
        new Promise<[number | null, NodeJS.Signals | null]>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for detached processTree fixture to exit')), 20_000),
        ),
      ]);
      expect(code).toBe(0);
      expect(signal).toBeNull();
    } finally {
      try {
        if (typeof child.pid === 'number') {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        // ignore
      }
    }
  });
});
