import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export function spawnTestProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawn(command, [...args], {
    stdio: 'ignore',
    ...options,
  });

  if (!child.pid) {
    throw new Error('Failed to spawn test process');
  }

  return child;
}

export function spawnDetachedTestProcess(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const child = spawnTestProcess(command, args, {
    detached: true,
    ...options,
  });
  child.unref();
  return child;
}

export function spawnDetachedInlineNodeTestProcess(source: string, options: SpawnOptions = {}): ChildProcess {
  return spawnDetachedTestProcess(process.execPath, ['-e', source], options);
}
