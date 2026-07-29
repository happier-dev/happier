import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { spawnVoiceInferenceWorkerChannel } from './spawnWorkerChannel';

vi.mock('@/utils/spawnHappyCLI', () => ({
  spawnHappyCLI: vi.fn(),
}));

describe('spawnVoiceInferenceWorkerChannel', () => {
  it('contains an asynchronous EPIPE after a native worker crash and settles through termination', async () => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdin: PassThrough;
      stdout: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = 42_424;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = vi.fn(() => true);
    // Narrow fixture cast at the genuine child-process system boundary.
    vi.mocked(spawnHappyCLI).mockReturnValue(child as unknown as ChildProcess);

    const channel = spawnVoiceInferenceWorkerChannel();
    const brokenPipe = Object.assign(new Error('write EPIPE'), {
      code: 'EPIPE',
      errno: -32,
      syscall: 'write',
    });

    expect(() => child.stdin.emit('error', brokenPipe)).not.toThrow();
    child.emit('exit', 137, null);
    await expect(channel.waitForTermination()).resolves.toEqual({ type: 'exited', code: 137 });
  });
});
