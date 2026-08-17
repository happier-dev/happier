import { describe, expect, it, vi } from 'vitest';

import type { ExecService } from '@happier-dev/plugin-sdk/exec';

import { createAntigravityNativeCliPrintExecRun } from './nativeExec.js';

describe('createAntigravityNativeCliPrintExecRun', () => {
  it('runs agy through the stable system-tool and process owners', async () => {
    const resolve = vi.fn(async () => ({
      executable: { kind: 'systemTool' as const, id: 'antigravity-cli' },
      executablePath: '/usr/local/bin/agy',
    }));
    const run = vi.fn(async () => ({
      termination: {
        observed: { kind: 'exit' as const, exitCode: 0 },
        requestedBy: { kind: 'none' as const },
      },
      stdout: new TextEncoder().encode('assistant output'),
      stderr: new TextEncoder().encode(''),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const exec = { systemTools: { resolve }, run } as unknown as ExecService;
    const signal = new AbortController().signal;
    const runAgentCli = createAntigravityNativeCliPrintExecRun(exec);

    await expect(runAgentCli({
      kind: 'agent-cli',
      agentId: 'antigravity',
      args: ['-p', 'hello'],
      cwd: '/repo',
      env: { SAFE_TEST_ENV: 'kept' },
    }, {
      signal,
      timeoutMs: 120_000,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    })).resolves.toEqual({
      exitCode: 0,
      signal: null,
      stdout: 'assistant output',
      stderr: '',
    });

    expect(resolve).toHaveBeenCalledWith({
      toolId: 'antigravity-cli',
      purpose: 'Run an Antigravity CLI print turn.',
      cwd: '/repo',
      signal,
    });
    expect(run).toHaveBeenCalledWith({
      executable: { kind: 'systemTool', id: 'antigravity-cli' },
      args: ['-p', 'hello'],
      env: { SAFE_TEST_ENV: 'kept' },
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
      timeoutMs: 120_000,
    }, { signal });
  });
});
