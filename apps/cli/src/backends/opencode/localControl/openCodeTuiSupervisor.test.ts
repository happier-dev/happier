import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { createOpenCodeTuiSupervisor } from './openCodeTuiSupervisor';

type SpawnedProcessHarness = Readonly<{
  child: {
    exitCode: number | null;
    killed: boolean;
    once: {
      (event: 'exit', handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
      (event: 'error', handler: (error: Error) => void): void;
    };
    kill: ReturnType<typeof vi.fn>;
  };
  emitExit: () => void;
  emitError: (error?: Error) => void;
}>;

function createSpawnedProcessHarness(): SpawnedProcessHarness {
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errorHandlers: Array<(error: Error) => void> = [];

  const child = {
    exitCode: null as number | null,
    killed: false,
    once: vi.fn((event: 'exit' | 'error', handler: ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void)) => {
      if (event === 'exit') exitHandlers.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void);
      if (event === 'error') errorHandlers.push(handler as (error: Error) => void);
    }),
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGINT' || signal === 'SIGKILL') {
        child.killed = true;
      }
      return true;
    }),
  };

  return {
    child,
    emitExit: () => {
      child.exitCode = 0;
      for (const handler of exitHandlers.splice(0)) {
        handler(0, null);
      }
    },
    emitError: (error = new Error('spawn failed')) => {
      for (const handler of errorHandlers.splice(0)) {
        handler(error);
      }
    },
  };
}

async function createFakeExecutable(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-opencode-cli-'));
  const commandPath = join(root, name);
  await writeFile(commandPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(commandPath, 0o755);
  return commandPath;
}

describe('createOpenCodeTuiSupervisor', () => {
  it('spawns the resolved opencode attach command with inherited stdio and tracks attachment state', async () => {
    const proc = createSpawnedProcessHarness();
    const spawnProcess = vi.fn(() => proc.child as any);
    const commandPath = await createFakeExecutable('opencode');
    const supervisor = createOpenCodeTuiSupervisor({
      spawnProcess,
      env: { HAPPIER_OPENCODE_PATH: commandPath } as NodeJS.ProcessEnv,
    });

    await expect(supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    })).resolves.toBe(true);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess).toHaveBeenCalledWith(
      commandPath,
      ['attach', 'http://127.0.0.1:4096', '--dir', '/tmp/workspace', '--session', 'session-1'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(supervisor.isAttached()).toBe(true);

    proc.emitExit();
    expect(supervisor.isAttached()).toBe(false);
  });

  it('detaches the running process and clears attachment state', async () => {
    const proc = createSpawnedProcessHarness();
    const spawnProcess = vi.fn(() => proc.child as any);
    const supervisor = createOpenCodeTuiSupervisor({ spawnProcess });

    await supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    });

    const detachPromise = supervisor.detach();
    expect(proc.child.kill).toHaveBeenCalledWith('SIGINT');
    proc.emitExit();
    await detachPromise;

    expect(supervisor.isAttached()).toBe(false);
  });

  it('fails closed when the attach process errors before startup completes', async () => {
    const proc = createSpawnedProcessHarness();
    const spawnProcess = vi.fn(() => proc.child as any);
    const supervisor = createOpenCodeTuiSupervisor({ spawnProcess });

    const attachPromise = supervisor.attach({
      baseUrl: 'http://127.0.0.1:4096',
      directory: '/tmp/workspace',
      sessionId: 'session-1',
    });
    proc.emitError(new Error('ENOENT'));

    await expect(attachPromise).resolves.toBe(false);
    expect(supervisor.isAttached()).toBe(false);
  });
});
