import { describe, expect, it, vi } from 'vitest';
import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';

import {
  GROK_PREFLIGHT_SESSION_CONTROLS,
  parseGrokModelsOutput,
} from './models.js';

describe('parseGrokModelsOutput', () => {
  it('returns only provider-advertised model identities from the Grok models command', () => {
    expect(parseGrokModelsOutput(`
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
    grok-code-fast-1
`)).toEqual([
      { id: 'grok-4.5', name: 'Grok 4.5' },
      { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' },
    ]);
  });

  it('fails closed for missing, malformed, or duplicate model rows', () => {
    expect(parseGrokModelsOutput('Available models:\n')).toBeNull();
    expect(parseGrokModelsOutput('Available models:\n  * ../../bad (default)')).toBeNull();
    expect(parseGrokModelsOutput('Available models:\n  * grok-4.5\n  grok-4.5')).toBeNull();
  });
});

describe('GROK_PREFLIGHT_SESSION_CONTROLS', () => {
  it('runs the official models command through the host agent-cli executor', async () => {
    const executable = { kind: 'systemTool' as const, id: 'grok-cli' };
    const run = vi.fn(async () => ({
      termination: {
        observed: { kind: 'exit' as const, exitCode: 0 },
        requestedBy: { kind: 'none' as const },
      },
      stdout: new TextEncoder().encode('Available models:\n  * grok-4.5 (default)\n'),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const exec = {
      run,
      systemTools: {
        resolve: async () => ({ executable, executablePath: '/managed/grok' }),
      },
      spawn: async () => { throw new Error('spawn should not be used'); },
      clients: { spawn: async () => { throw new Error('protocol clients should not be used'); } },
      agentCli: { checkReadiness: async () => { throw new Error('agent CLI readiness should not be used'); } },
    } satisfies PluginExecService;

    await expect(GROK_PREFLIGHT_SESSION_CONTROLS.probeModelsRaw({
      exec,
      cwd: '/workspace',
      timeoutMs: 1_500,
    })).resolves.toEqual([{ id: 'grok-4.5', name: 'Grok 4.5' }]);

    expect(run).toHaveBeenCalledWith({
      executable: { kind: 'systemTool', id: 'grok-cli' },
      args: ['models'],
      cwd: { root: 'workspace', relativePath: '' },
      maxStderrBytes: 262_144,
      maxStdoutBytes: 262_144,
      timeoutMs: 1_500,
    });
  });
});
