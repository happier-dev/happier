import { expect, it, vi } from 'vitest';
import type { ExecService, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createDockerSandboxesProvider } from './provider.js';

const resource = { sandboxName: 'happier-preflight-test' };
const executable = { kind: 'systemTool', id: 'sbx' } as const;
const result = (exitCode: number): PluginProcessResult => ({
  termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
  stdout: new Uint8Array([0, 255]), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
});

function boundary(outcome: PluginProcessResult) {
  // Native processes are the system boundary; all provider logic stays real.
  const run = vi.fn<ExecService['run']>(async request => request.args?.[0] === 'ls'
    ? { ...result(0), stdout: new TextEncoder().encode(JSON.stringify([{ name: resource.sandboxName, status: 'stopped' }])) }
    : outcome);
  const channel: PluginProcessHandle = {
    write: vi.fn(async () => {}), closeStdin: vi.fn(async () => {}),
    waitForExit: async () => outcome.termination, wait: async () => outcome,
    onOutput: () => ({ dispose() {} }), dispose: vi.fn(async () => {}),
  };
  const spawn = vi.fn<ExecService['spawn']>(async () => channel);
  return { run, spawn, channel, provider: createDockerSandboxesProvider({ run, spawn }, executable, 123) };
}

it.each(['exec', 'stream', 'bootstrap'] as const)('%s performs zero sandbox inventory reads', async role => {
  const { provider, run, spawn } = boundary(result(0));
  if (role === 'exec') expect(await provider.exec(resource, ['true'])).toEqual(result(0));
  else if (role === 'stream') {
    const channel = await provider.stream(resource, ['true']);
    expect(await channel.waitForExit()).toEqual(result(0).termination);
    await channel.dispose();
  } else expect(await provider.bootstrap(resource)).toMatchObject({ kind: 'native' });
  expect(run.mock.calls.filter(([request]) => request.args?.[0] === 'ls')).toHaveLength(0);
  expect(run.mock.calls.length + spawn.mock.calls.length).toBe(role === 'bootstrap' ? 0 : 1);
});

it.each(['exec', 'stream-exit', 'stream-wait', 'put-file'] as const)('%s maps native exit 125 to the existing absent cause', async role => {
  const { provider, run, spawn } = boundary(result(125));
  const invoke = async () => {
    if (role === 'exec') return provider.exec(resource, ['true']);
    if (role === 'put-file') return provider.putFile(resource, '/tmp/payload', new Uint8Array([255]));
    const channel = await provider.stream(resource, ['true']);
    try { return await (role === 'stream-exit' ? channel.waitForExit() : channel.wait()); }
    finally { await channel.dispose(); }
  };
  await expect(invoke()).rejects.toMatchObject({ code: 'docker_sandbox_absent' });
  expect([...run.mock.calls, ...spawn.mock.calls].map(([request]) => request.args?.[0])).toEqual(['exec']);
});

it('preserves requested cancellation and ordinary guest command failures', async () => {
  for (const outcome of [result(17), { ...result(125), termination: {
    observed: { kind: 'exit' as const, exitCode: 125 }, requestedBy: { kind: 'abort' as const },
  } }]) {
    const { provider } = boundary(outcome);
    expect(await provider.exec(resource, ['true'])).toEqual(outcome);
    const channel = await provider.stream(resource, ['true']);
    expect(await channel.waitForExit()).toEqual(outcome.termination);
    expect(await channel.wait()).toEqual(outcome);
    await channel.dispose();
  }
});
