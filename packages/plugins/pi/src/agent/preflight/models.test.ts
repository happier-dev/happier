import { describe, expect, it } from 'vitest';
import type {
  PluginExecService,
  PluginExecSpawnRequest,
} from '@happier-dev/plugin-sdk/runtime';

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
    input: PluginExecSpawnRequest & { timeoutMs?: number };
    options: { signal?: AbortSignal } | undefined;
  }>> = [];
  const resolvedExecutable = Object.freeze({
    kind: 'systemTool' as const,
    id: 'pi-cli',
  });
  const exec = {
    systemTools: {
      resolve: async () => ({
        executable: resolvedExecutable,
        executablePath: '/managed/pi',
      }),
    },
    run: async (input, options) => {
      runs.push({ input, options });
      return {
        termination: {
          observed: params.exitCode === null
            ? { kind: 'signal' as const, signal: 'SIGTERM' }
            : { kind: 'exit' as const, exitCode: params.exitCode ?? 0 },
          requestedBy: { kind: 'none' as const },
        },
        stdout: new TextEncoder().encode(params.stdout ?? ''),
        stderr: new TextEncoder().encode(params.stderr ?? ''),
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    },
    spawn: async () => {
      throw new Error('spawn should not be used for Pi model preflight');
    },
    clients: {
      spawn: async () => {
        throw new Error('protocol clients should not be used for Pi model preflight');
      },
    },
    agentCli: {
      checkReadiness: async () => {
        throw new Error('agent CLI readiness should not be used for Pi model preflight');
      },
    },
  } satisfies PluginExecService;
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
        GEMINI_API_KEY: undefined,
        PI_CODING_AGENT_DIR: '/isolated/pi-agent-dir',
        HOME: '/isolated/home',
        XDG_CONFIG_HOME: '/isolated/xdg',
        USERPROFILE: 'C:\\isolated\\home',
        HAPPIER_PI_THINKING_LEVEL: 'high',
        UNRELATED_SECRET: 'must-not-reach-pi',
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
        executable: { kind: 'systemTool', id: 'pi-cli' },
        args: ['--list-models'],
        cwd: { root: 'workspace', relativePath: '' },
        env: {
          CI: '1',
          OPENAI_API_KEY: 'sk-test',
          PI_CODING_AGENT_DIR: '/isolated/pi-agent-dir',
          HOME: '/isolated/home',
          XDG_CONFIG_HOME: '/isolated/xdg',
          USERPROFILE: 'C:\\isolated\\home',
          HAPPIER_PI_THINKING_LEVEL: 'high',
        },
        maxStderrBytes: 262_144,
        maxStdoutBytes: 262_144,
        timeoutMs: 2_500,
      },
      options: undefined,
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
