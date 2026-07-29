import { describe, expect, it } from 'vitest';
import type {
  PluginExecService,
  PluginExecSpawnRequest,
} from '@happier-dev/plugin-sdk/runtime';

import {
  buildOhMyPiPreflightModelsFromListModelsOutput,
  OH_MY_PI_PREFLIGHT_SESSION_CONTROLS,
} from './models.js';

function createExecRunFixture(params: Readonly<{
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}> = {}) {
  const runs: Array<Readonly<{
    input: PluginExecSpawnRequest & { timeoutMs?: number };
    options: { signal?: AbortSignal } | undefined;
  }>> = [];
  const executable = { kind: 'systemTool' as const, id: 'ohmypi-cli' };
  const exec = {
    systemTools: {
      resolve: async () => ({ executable, executablePath: '/managed/omp' }),
    },
    run: async (input, options) => {
      runs.push({ input, options });
      return {
        termination: {
          observed: { kind: 'exit' as const, exitCode: params.exitCode ?? 0 },
          requestedBy: { kind: 'none' as const },
        },
        stdout: new TextEncoder().encode(params.stdout ?? ''),
        stderr: new TextEncoder().encode(params.stderr ?? ''),
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
    spawn: async () => {
      throw new Error('spawn should not be used for OhMyPi model preflight');
    },
    clients: { spawn: async () => { throw new Error('protocol clients should not be used'); } },
    agentCli: { checkReadiness: async () => { throw new Error('agent CLI readiness should not be used'); } },
  } satisfies PluginExecService;
  return { exec, runs };
}

describe('OhMyPi preflight model parsing', () => {
  it('builds dynamic models with Thinking options from omp list-models output', () => {
    const models = buildOhMyPiPreflightModelsFromListModelsOutput([
      'provider      model                       context  max-out  thinking  images',
      'openai        gpt-5.4                     272K     128K     yes       yes',
      'anthropic     claude-3-7-sonnet-latest    200K     64K      no        yes',
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
        id: 'anthropic/claude-3-7-sonnet-latest',
        name: 'claude-3-7-sonnet-latest',
        description: 'anthropic',
      },
    ]);
  });

  it('treats no-credential model diagnostics as dynamically unavailable', () => {
    expect(buildOhMyPiPreflightModelsFromListModelsOutput(
      'No models available. Set API keys in environment variables.\n',
    )).toBeNull();
  });

  it('treats embedding-only list-models output as unavailable for chat sessions', () => {
    expect(buildOhMyPiPreflightModelsFromListModelsOutput([
      'provider  model                    context  max-out  thinking  images',
      'ollama    nomic-embed-text:latest  2.0K     2.0K     -         no',
      'ollama    qwen3-embedding:8b       41K      8.2K     -         no',
    ].join('\n'))).toBeNull();
  });

  it('probes list-models through the binary-safe agent CLI exec path with credential env', async () => {
    const raw = [
      'provider      model                       context  max-out  thinking  images',
      'openai        gpt-5.4                     272K     128K     yes       yes',
    ].join('\n');
    const fixture = createExecRunFixture({ stdout: raw });

    await expect(OH_MY_PI_PREFLIGHT_SESSION_CONTROLS.probeModelsRaw?.({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 2_500,
      env: {
        CI: '0',
        OPENAI_API_KEY: 'sk-test',
        ANTHROPIC_API_KEY: undefined,
      },
    })).resolves.toEqual([{
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
    }]);
    expect(fixture.runs).toEqual([{
      input: {
        executable: { kind: 'systemTool', id: 'ohmypi-cli' },
        args: ['--list-models'],
        cwd: { root: 'workspace', relativePath: '' },
        env: {
          CI: '1',
          OPENAI_API_KEY: 'sk-test',
        },
        maxStderrBytes: 262_144,
        maxStdoutBytes: 262_144,
        timeoutMs: 2_500,
      },
      options: undefined,
    }]);
  });

  it('treats failed list-models probes as unavailable', async () => {
    const fixture = createExecRunFixture({
      exitCode: 1,
      stdout: 'provider model\nopenai gpt-5.4\n',
      stderr: 'boom',
    });

    await expect(OH_MY_PI_PREFLIGHT_SESSION_CONTROLS.probeModelsRaw?.({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 2_500,
      env: { OPENAI_API_KEY: 'sk-test' },
    })).resolves.toBeNull();
  });
});
