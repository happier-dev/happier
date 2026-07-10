import { describe, expect, it } from 'vitest';
import type {
  ExecLaunchInputV1,
  ExecRunOptionsV1,
  ExecRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import {
  buildPiPreflightModelsFromListModelsOutput,
  PI_PREFLIGHT_SESSION_CONTROLS,
} from './models.js';

function createExecRunFixture(params: Readonly<{
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}> = {}) {
  const runs: Array<Readonly<{
    input: ExecLaunchInputV1;
    options: ExecRunOptionsV1 | undefined;
  }>> = [];
  const exec: ExecRuntimeServiceV1 = {
    systemTools: {
      resolve: async () => {
        throw new Error('system tools should not be used for Pi model preflight');
      },
    },
    run: async (input, options) => {
      runs.push({ input, options });
      return {
        exitCode: params.exitCode ?? 0,
        signal: null,
        stdout: params.stdout ?? '',
        stderr: params.stderr ?? '',
      };
    },
    spawn: async () => {
      throw new Error('spawn should not be used for Pi model preflight');
    },
    spawnClient: (async () => {
      throw new Error('spawnClient should not be used for Pi model preflight');
    }) as ExecRuntimeServiceV1['spawnClient'],
  };
  return { exec, runs };
}

describe('Pi preflight model parsing', () => {
  it('adds a Thinking option only for models that report thinking support', () => {
    const models = buildPiPreflightModelsFromListModelsOutput([
      'provider  model  context  max-out  thinking  images',
      'openai  gpt-5.4  200K  4K  yes  yes',
      'openai  gpt-4o-mini  128K  4K  no  yes',
    ].join('\n'));

    expect(models).toEqual([
      {
        id: 'openai/gpt-5.4',
        name: 'gpt-5.4',
        description: 'openai',
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
              { value: 'xhigh', name: 'Max' },
            ],
          },
        ],
      },
      {
        id: 'openai/gpt-4o-mini',
        name: 'gpt-4o-mini',
        description: 'openai',
      },
    ]);
  });

  it('returns null when Pi emits no parseable model rows', () => {
    expect(buildPiPreflightModelsFromListModelsOutput('provider model\n')).toBeNull();
    expect(buildPiPreflightModelsFromListModelsOutput('')).toBeNull();
  });

  it('probes list-models through the binary-safe agent CLI exec path and parses stderr output', async () => {
    const raw = [
      'provider      model                       context  max-out  thinking  images',
      'openai-codex  gpt-5.4                     272K     128K     yes       yes',
    ].join('\n');
    const fixture = createExecRunFixture({ stderr: raw });

    await expect(PI_PREFLIGHT_SESSION_CONTROLS.probeModelsRaw?.({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 2_500,
      env: {
        CI: '0',
        OPENAI_API_KEY: 'sk-test',
        ANTHROPIC_API_KEY: undefined,
      },
    })).resolves.toEqual([{
      id: 'openai-codex/gpt-5.4',
      name: 'gpt-5.4',
      description: 'openai-codex',
      modelOptions: [
        {
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
            { value: 'xhigh', name: 'Max' },
          ],
        },
      ],
    }]);
    expect(fixture.runs).toEqual([{
      input: {
        kind: 'agent-cli',
        agentId: 'pi',
        args: ['--list-models'],
        cwd: '/workspace',
        env: {
          CI: '1',
          OPENAI_API_KEY: 'sk-test',
        },
      },
      options: {
        maxStderrBytes: 262_144,
        maxStdoutBytes: 262_144,
        timeoutMs: 2_500,
      },
    }]);
  });

  it('declares provider-owned raw probing instead of legacy projection command adaptation', () => {
    expect(PI_PREFLIGHT_SESSION_CONTROLS).toEqual(expect.objectContaining({
      failureCacheStrategy: 'cooldown',
      probeModelsRaw: expect.any(Function),
    }));
    expect(PI_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('probeModelsCommandArgs');
    expect(PI_PREFLIGHT_SESSION_CONTROLS).not.toHaveProperty('probeModelsFromCommandOutput');
  });
});
