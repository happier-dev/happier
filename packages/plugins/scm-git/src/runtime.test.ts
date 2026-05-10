import { describe, expect, it } from 'vitest';

import * as scmBackendRuntime from '@happier-dev/plugin-sdk/scm/backend';

import { runScmCommand } from './runtime.js';

describe('Git SCM plugin runtime', () => {
  it('delegates command execution to the host SCM backend runtime service', async () => {
    const sdkRuntime = scmBackendRuntime as Record<string, unknown>;
    expect(sdkRuntime.runWithScmBackendRuntimeServices).toBeTypeOf('function');
    const runWithScmBackendRuntimeServices = sdkRuntime.runWithScmBackendRuntimeServices as <T>(
      services: {
        runCommand(input: unknown): Promise<{
          success: boolean;
          stdout: string;
          stderr: string;
          exitCode: number;
        }>;
      },
      callback: () => Promise<T>,
    ) => Promise<T>;
    const calls: unknown[] = [];

    const result = await runWithScmBackendRuntimeServices({
      async runCommand(input) {
        calls.push(input);
        return {
          success: true,
          stdout: 'ok',
          stderr: '',
          exitCode: 0,
        };
      },
    }, async () => await runScmCommand({
      bin: 'git',
      cwd: '/repo',
      args: ['status', '--short'],
      timeoutMs: 123,
      stdin: 'input',
      maxOutputBytes: 456,
      env: { GIT_TERMINAL_PROMPT: '0' },
    }));

    expect(result).toEqual({
      success: true,
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    });
    expect(calls).toEqual([
      {
        installableKey: 'dep.git',
        command: 'git',
        cwd: '/repo',
        args: ['status', '--short'],
        timeoutMs: 123,
        stdin: 'input',
        maxOutputBytes: 456,
        env: { GIT_TERMINAL_PROMPT: '0' },
      },
    ]);
  });
});
