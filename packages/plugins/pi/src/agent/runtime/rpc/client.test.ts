import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import { describe, expect, it, vi } from 'vitest';

import { createPiJsonStreamRpcClient } from './client.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function processResult(
  observed: PluginProcessResult['termination']['observed'],
  stderr = '',
): PluginProcessResult {
  return {
    termination: {
      observed,
      requestedBy: { kind: 'none' },
    },
    stdout: new Uint8Array(),
    stderr: new TextEncoder().encode(stderr),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function createHarness(write: (value: JsonValue) => Promise<void>) {
  const terminal = deferred<PluginProcessResult>();
  const wait = vi.fn(() => terminal.promise);
  const handle: PluginProtocolClientHandle<'jsonStream'> = {
    client: {
      write,
      subscribe: () => ({ dispose() {} }),
      async dispose() {},
    },
    process: {
      async write() {},
      async closeStdin() {},
      wait,
      onOutput: () => ({ dispose() {} }),
      async dispose() {},
    },
    wait,
    async dispose() {},
  };
  return {
    client: createPiJsonStreamRpcClient({ handle }),
    terminal,
    wait,
  };
}

describe('createPiJsonStreamRpcClient', () => {
  it('rejects a written request from the single terminal result instead of waiting for its timeout', async () => {
    const writeStarted = deferred<void>();
    const harness = createHarness(async () => {
      writeStarted.resolve();
    });
    const exits: unknown[] = [];
    harness.client.onExit((result) => exits.push(result));

    const request = harness.client.send({ type: 'get_state' }, 60_000);
    await writeStarted.promise;
    harness.terminal.resolve(processResult(
      { kind: 'exit', exitCode: 23 },
      'nested Pi child failure; apiKey=top-secret-value',
    ));

    const error = await request.catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: expect.stringMatching(/exit code 23.*nested Pi child failure/u),
    });
    expect(error).not.toMatchObject({ message: expect.stringContaining('top-secret-value') });
    expect(exits).toEqual([expect.objectContaining({
      exitCode: 23,
      signal: null,
      error: expect.objectContaining({ message: error.message }),
    })]);
    expect(harness.wait).toHaveBeenCalledOnce();
  });

  it('lets the exact process terminal supersede a clean-EOF write rejection already racing in send', async () => {
    const writeStarted = deferred<void>();
    const harness = createHarness(async () => {
      writeStarted.resolve();
      throw new PluginError({
        code: 'PLUGIN_EXEC_CLIENT_DISPOSED',
        message: 'Plugin exec client stream is closed',
        details: { jsonStreamWriteOutcome: 'rejected_before_write' },
      });
    });

    const request = harness.client.send({ type: 'get_state' }, 60_000);
    await writeStarted.promise;
    harness.terminal.resolve(processResult({ kind: 'signal', signal: 'SIGTERM' }));

    await expect(request).rejects.toThrow(/signal SIGTERM/u);
    expect(harness.wait).toHaveBeenCalledOnce();
  });

  it('keeps a non-clean write failure authoritative when process termination races first', async () => {
    const writeStarted = deferred<void>();
    const writeResult = deferred<void>();
    const terminalObserved = deferred<void>();
    const writeError = new PluginError({
      code: 'PLUGIN_EXEC_CLIENT_WRITE_FAILED',
      message: 'write failed with EPIPE',
    });
    const harness = createHarness(async () => {
      writeStarted.resolve();
      await writeResult.promise;
    });
    harness.client.onExit(() => terminalObserved.resolve());

    const request = harness.client.send({ type: 'get_state' }, 60_000);
    await writeStarted.promise;
    harness.terminal.resolve(processResult({ kind: 'exit', exitCode: 25 }, 'child terminal detail'));
    await terminalObserved.promise;
    writeResult.reject(writeError);

    await expect(request).rejects.toBe(writeError);
    expect(harness.wait).toHaveBeenCalledOnce();
  });

  it('consumes an already-observed terminal when an in-flight write later succeeds', async () => {
    const writeStarted = deferred<void>();
    const writeResult = deferred<void>();
    const terminalObserved = deferred<void>();
    const harness = createHarness(async () => {
      writeStarted.resolve();
      await writeResult.promise;
    });
    harness.client.onExit(() => terminalObserved.resolve());

    const request = harness.client.send({ type: 'get_state' }, 60_000);
    await writeStarted.promise;
    harness.terminal.resolve(processResult({ kind: 'exit', exitCode: 26 }, 'terminal after write started'));
    await terminalObserved.promise;
    writeResult.resolve();

    await expect(request).rejects.toThrow(/exit code 26.*terminal after write started/u);
    expect(harness.wait).toHaveBeenCalledOnce();
  });

  it('preserves a failed process diagnostic while redacting its sensitive detail', async () => {
    const harness = createHarness(async () => undefined);
    const request = harness.client.send({ type: 'get_state' }, 60_000);
    harness.terminal.resolve(processResult({
      kind: 'failed',
      diagnostic: {
        code: 'PI_CHILD_BOOTSTRAP_FAILED',
        severity: 'error',
        message: 'bootstrap failed; token=top-secret-value',
      },
    }));

    const error = await request.catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      message: expect.stringMatching(/PI_CHILD_BOOTSTRAP_FAILED.*bootstrap failed/u),
    });
    expect(error).not.toMatchObject({ message: expect.stringContaining('top-secret-value') });
    expect(harness.wait).toHaveBeenCalledOnce();
  });
});
