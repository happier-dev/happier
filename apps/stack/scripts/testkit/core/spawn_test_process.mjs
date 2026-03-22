import { spawn } from 'node:child_process';

export function spawnTestProcess(command, args = [], options = {}) {
  const child = spawn(command, [...args], {
    stdio: 'ignore',
    ...options,
  });

  if (!child.pid) {
    throw new Error('Failed to spawn test process');
  }

  return child;
}

export function spawnDetachedTestProcess(command, args = [], options = {}) {
  const child = spawnTestProcess(command, args, {
    detached: true,
    ...options,
  });
  child.unref();
  return child;
}

export function spawnDetachedInlineNodeTestProcess(source, options = {}) {
  return spawnDetachedTestProcess(process.execPath, ['-e', source], options);
}
