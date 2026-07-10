import { describe, expect, it } from 'vitest';

import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { CURSOR_AGENT_RUNTIME_CONTRIBUTION } from './runtime.js';

describe('Cursor agent runtime contribution', () => {
  it('probes Cursor models through the provider-owned preflight hook', async () => {
    const launches: unknown[] = [];
    const exec: Pick<ExecRuntimeServiceV1, 'run'> = {
      run: async (launch) => {
        launches.push(launch);
        return {
          exitCode: 0,
          signal: null,
          stdout: [
            'Available models',
            '',
            'auto - Auto',
            'composer-2.5-fast - Composer 2.5 Fast (current, default)',
          ].join('\n'),
          stderr: '',
        };
      },
    };

    await expect(CURSOR_AGENT_RUNTIME_CONTRIBUTION.preflightSessionControls.probeModelsRaw?.({
      exec: exec as ExecRuntimeServiceV1,
      cwd: '/repo',
      timeoutMs: 5000,
      env: { CURSOR_API_KEY: 'cursor-key' },
    })).resolves.toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
    ]);

    expect(launches).toEqual([
      {
        kind: 'agent-cli',
        agentId: 'cursor',
        args: ['models'],
        cwd: '/repo',
        env: { CURSOR_API_KEY: 'cursor-key' },
      },
    ]);
  });
});
