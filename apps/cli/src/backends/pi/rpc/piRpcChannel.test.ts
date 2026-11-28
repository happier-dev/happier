import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { describe, expect, it } from 'vitest';

import { createSpawnedPiRpcChannel } from './piRpcChannel';

describe('createSpawnedPiRpcChannel', () => {
  it('replays startup output before closure when the process exits before listening', async () => {
    const child = spawn(process.execPath, ['-e', 'console.log("startup frame"); console.error("startup diagnostic");'], { stdio: 'pipe' });
    const channel = createSpawnedPiRpcChannel(child);
    await once(child, 'close');

    const output: string[] = [];
    const events: string[] = [];
    channel.listen({
      onStdoutLine: (line) => { output.push(line); events.push('stdout'); },
      onStderrLine: (line) => { output.push(line); events.push('stderr'); },
      onIoError: (_error) => events.push('io-error'),
      onClosed: (closure) => events.push(closure.kind),
    });

    expect(output.sort()).toEqual(['startup diagnostic', 'startup frame']);
    expect(events.slice(0, -1).sort()).toEqual(['stderr', 'stdout']);
    expect(events.at(-1)).toBe('exited');
  });

  it('settles repeated close calls after the child has already closed', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'pipe' });
    const channel = createSpawnedPiRpcChannel(child);
    await once(child, 'close');

    await Promise.all([channel.close(), channel.close()]);
    await expect(channel.close()).resolves.toBeUndefined();
  });
});
