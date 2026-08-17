import { describe, expect, it, vi } from 'vitest';

import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';

import { openAntigravityNativeLocalharnessClient } from './nativeClient.js';

describe('openAntigravityNativeLocalharnessClient', () => {
  it('spawns the managed child through the stable dynamic-handshake service', async () => {
    const send = vi.fn(async () => undefined);
    const subscribe = vi.fn(() => ({ dispose: vi.fn() }));
    const wait = vi.fn(async (): Promise<PluginProcessResult> => ({
      termination: {
        observed: { kind: 'exit', exitCode: 9 },
        requestedBy: { kind: 'none' },
      },
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const dispose = vi.fn(async () => undefined);
    const spawn = vi.fn(async () => ({
      client: { send, subscribe, dispose },
      process: {} as never,
      wait,
      dispose,
    }));
    const exec = { clients: { spawn } } as unknown as Pick<ExecService, 'clients'>;
    const requestFrame = new Uint8Array([1, 2, 3]);

    const client = await openAntigravityNativeLocalharnessClient({ exec, requestFrame });

    expect(spawn).toHaveBeenCalledWith({
      kind: 'loopbackWebSocketJson',
      launch: {
        executable: { kind: 'managedDependency', id: 'localharness' },
      },
      handshake: {
        framing: 'lengthPrefix',
        byteOrder: 'little-endian',
        requestFrames: [requestFrame],
        decodeResponse: expect.any(Function),
      },
      maxFrameBytes: 1024 * 1024,
    }, undefined);

    await client.send({ userInput: 'hello' });
    expect(send).toHaveBeenCalledWith({ userInput: 'hello' });

    const onExit = vi.fn();
    client.onExit(onExit);
    await wait();
    await Promise.resolve();
    expect(onExit).toHaveBeenCalledWith({ exitCode: 9, signal: null });

    await client.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});
