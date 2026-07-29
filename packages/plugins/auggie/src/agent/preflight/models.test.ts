import { describe, expect, it } from 'vitest';

import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';

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
    const executable = { kind: 'systemTool' as const, id: 'auggie-cli' };
    const exec = {
      systemTools: {
        resolve: async () => ({ executable, executablePath: '/managed/auggie' }),
      },
      run: async (launch) => {
        launches.push(launch);
        return {
          termination: {
            observed: { kind: 'exit' as const, exitCode: 0 },
            requestedBy: { kind: 'none' as const },
          },
          stdout: new TextEncoder().encode(JSON.stringify({
            models: [
              { displayName: 'Prism', shortName: 'prism-a' },
            ],
          })),
          stderr: new Uint8Array(),
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
      spawn: async () => { throw new Error('spawn should not be used'); },
      clients: { spawn: async () => { throw new Error('protocol clients should not be used'); } },
      agentCli: { checkReadiness: async () => { throw new Error('agent CLI readiness should not be used'); } },
    } satisfies PluginExecService;

    await expect(AUGGIE_PREFLIGHT_SESSION_CONTROLS.probeModelsRaw?.({
      exec,
      cwd: '/repo',
      timeoutMs: 5000,
      env: { AUGMENT_SESSION_AUTH: 'auth-json' },
    })).resolves.toEqual([
      { id: 'prism-a', name: 'Prism' },
    ]);

    expect(launches).toEqual([
      {
        executable: { kind: 'systemTool', id: 'auggie-cli' },
        args: ['model', 'list', '--json'],
        cwd: { root: 'workspace', relativePath: '' },
        env: { AUGMENT_SESSION_AUTH: 'auth-json', CI: '1' },
        maxStderrBytes: 262_144,
        maxStdoutBytes: 262_144,
        timeoutMs: 5_000,
      },
    ]);
  });
});
