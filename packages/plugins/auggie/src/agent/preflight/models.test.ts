import { describe, expect, it } from 'vitest';

import type { ExecRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import {
  AUGGIE_PREFLIGHT_SESSION_CONTROLS,
  buildAuggiePreflightModelsFromModelListJson,
} from './models.js';

describe('Auggie preflight model probing', () => {
  it('parses Auggie model list JSON into preflight model descriptors', () => {
    expect(buildAuggiePreflightModelsFromModelListJson(JSON.stringify({
      defaultModelId: 'model-default-id',
      models: [
        {
          displayName: 'Opus 4.8',
          shortName: 'opus4.8',
          description: 'Great for complex tasks',
          effortLevels: ['Medium', 'High', 'xHigh'],
          isDefault: true,
        },
        {
          displayName: 'Haiku 4.5',
          shortName: 'haiku4.5',
          description: 'Fast responses',
        },
      ],
    }))).toEqual([
      {
        id: 'opus4.8',
        name: 'Opus 4.8',
        description: 'Great for complex tasks',
      },
      {
        id: 'haiku4.5',
        name: 'Haiku 4.5',
        description: 'Fast responses',
      },
    ]);
  });

  it('probes Auggie models through the provider-owned preflight hook', async () => {
    const launches: unknown[] = [];
    const exec: Pick<ExecRuntimeServiceV1, 'run'> = {
      run: async (launch) => {
        launches.push(launch);
        return {
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify({
            models: [
              { displayName: 'Prism', shortName: 'prism-a' },
            ],
          }),
          stderr: '',
        };
      },
    };

    await expect(AUGGIE_PREFLIGHT_SESSION_CONTROLS.probeModelsRaw?.({
      exec: exec as ExecRuntimeServiceV1,
      cwd: '/repo',
      timeoutMs: 5000,
      env: { AUGMENT_SESSION_AUTH: 'auth-json' },
    })).resolves.toEqual([
      { id: 'prism-a', name: 'Prism' },
    ]);

    expect(launches).toEqual([
      {
        kind: 'agent-cli',
        agentId: 'auggie',
        args: ['model', 'list', '--json'],
        cwd: '/repo',
        env: { AUGMENT_SESSION_AUTH: 'auth-json', CI: '1' },
      },
    ]);
  });
});
