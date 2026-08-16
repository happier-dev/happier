import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { describe, expect, it, vi } from 'vitest';

function createRunnerScriptHarness() {
  const scriptPath = resolve(__dirname, '../../../scripts/agent_cli_windows_shim_runner.cjs');
  const source = readFileSync(scriptPath, 'utf8').replace(/^#!.*\n/, '');
  const runLaunchSpec = vi.fn(async () => 0);
  const fakeProcess = Object.assign(new EventEmitter(), {
    argv: ['node', scriptPath],
    env: {},
    exit: vi.fn(),
    cwd: vi.fn(() => 'C:\\workspace'),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  });
  const module = { exports: {} as Record<string, unknown> };
  const fakeRequire = Object.assign((id: string) => {
    if (id === './terminal_launch_spec_runner.cjs') return { runLaunchSpec };
    throw new Error(`unexpected require: ${id}`);
  }, { main: {} });

  vm.runInNewContext(source, {
    console,
    module,
    exports: module.exports,
    process: fakeProcess,
    require: fakeRequire,
  });

  return { fakeProcess, module, runLaunchSpec };
}

describe('agent_cli_windows_shim_runner.cjs', () => {
  it('resolves the complete shim command after provider arguments are known', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    try {
      const { fakeProcess, module, runLaunchSpec } = createRunnerScriptHarness();
      const runAgentCli = module.exports.runAgentCli as (params: Readonly<{
        command: string;
        args: readonly string[];
        resolveCommandInvocation: typeof resolveWindowsCommandInvocation;
      }>) => Promise<number>;

      const command = 'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd';
      const args = ['--continue', 'prompt with spaces'];
      const expectedInvocation = resolveWindowsCommandInvocation({
        command,
        args,
        env: fakeProcess.env,
        resolveCommandOnPath: false,
      });

      await expect(runAgentCli({
        command,
        args,
        resolveCommandInvocation: resolveWindowsCommandInvocation,
      })).resolves.toBe(0);

      expect(runLaunchSpec).toHaveBeenCalledWith(expect.objectContaining({
        command: expectedInvocation.command,
        args: expectedInvocation.args,
        cwd: 'C:\\workspace',
        env: fakeProcess.env,
        windowsVerbatimArguments: true,
      }));
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });
});
