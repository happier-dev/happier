import { describe, expect, it } from 'vitest';

import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';

import { CURSOR_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Cursor agent runtime contribution', () => {
  it('probes Cursor models through the provider-owned preflight hook', async () => {
    const launches: unknown[] = [];
    const executable = { kind: 'systemTool' as const, id: 'cursor-agent' };
    const exec = {
      systemTools: {
        resolve: async () => ({ executable, executablePath: '/managed/cursor-agent' }),
      },
      run: async (launch) => {
        launches.push(launch);
        return {
          termination: {
            observed: { kind: 'exit' as const, exitCode: 0 },
            requestedBy: { kind: 'none' as const },
          },
          stdout: new TextEncoder().encode([
            'Available models',
            '',
            'auto - Auto',
            'composer-2.5-fast - Composer 2.5 Fast (current, default)',
          ].join('\n')),
          stderr: new Uint8Array(),
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      spawn: async () => { throw new Error('spawn should not be used'); },
      clients: { spawn: async () => { throw new Error('protocol clients should not be used'); } },
      agentCli: { checkReadiness: async () => { throw new Error('agent CLI readiness should not be used'); } },
    } satisfies PluginExecService;

    await expect(CURSOR_AGENT_RUNTIME_CONTRIBUTION.preflightSessionControls.probeModelsRaw?.({
      exec,
      cwd: '/repo',
      timeoutMs: 5000,
      env: { CURSOR_API_KEY: 'cursor-key' },
    })).resolves.toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
    ]);

    expect(launches).toEqual([
      {
        executable: { kind: 'systemTool', id: 'cursor-agent' },
        args: ['models'],
        cwd: { root: 'workspace', relativePath: '' },
        env: { CURSOR_API_KEY: 'cursor-key' },
        maxStderrBytes: 262_144,
        maxStdoutBytes: 262_144,
        timeoutMs: 5_000,
      },
    ]);
  });
});
