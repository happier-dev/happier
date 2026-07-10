import { describe, expect, it } from 'vitest';
import type {
  ExecLaunchInputV1,
  ExecRunOptionsV1,
  ExecRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import {
  buildOpenCodePreflightModelsFromVerboseOutput,
  OPENCODE_PREFLIGHT_SESSION_CONTROLS,
} from './models.js';

describe('OpenCode preflight model parsing', () => {
  type ExecRunFixtureResult = Readonly<{
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
  }>;

  function readProbeModelsRaw(value: unknown): ((params: Readonly<{
    exec: ExecRuntimeServiceV1;
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }>) => Promise<unknown | null> | unknown | null) | null {
    if (!value || typeof value !== 'object') return null;
    const probeModelsRaw = (value as Readonly<{ probeModelsRaw?: unknown }>).probeModelsRaw;
    return typeof probeModelsRaw === 'function' ? probeModelsRaw : null;
  }

  function createExecRunFixture(params: ExecRunFixtureResult & Readonly<{
    results?: readonly ExecRunFixtureResult[];
  }> = {}) {
    const runs: Array<Readonly<{
      input: ExecLaunchInputV1;
      options: ExecRunOptionsV1 | undefined;
    }>> = [];
    const exec: ExecRuntimeServiceV1 = {
      systemTools: {
        resolve: async () => {
          throw new Error('system tools should not be used for OpenCode model preflight');
        },
      },
      run: async (input, options) => {
        const runIndex = runs.length;
        runs.push({ input, options });
        const response = params.results ? params.results[runIndex] : params;
        if (!response) throw new Error(`unexpected exec run ${runIndex + 1}`);
        return {
          exitCode: response.exitCode ?? 0,
          signal: null,
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
        };
      },
      spawn: async () => {
        throw new Error('spawn should not be used for OpenCode model preflight');
      },
      spawnClient: (async () => {
        throw new Error('spawnClient should not be used for OpenCode model preflight');
      }) as ExecRuntimeServiceV1['spawnClient'],
    };
    return { exec, runs };
  }

  it('builds promptable models with model-scoped thinking options from verbose output', () => {
    const raw = [
      'openai/codex-mini-latest',
      '{',
      '  "id": "codex-mini-latest",',
      '  "providerID": "openai",',
      '  "name": "Codex Mini",',
      '  "family": "gpt-codex-mini",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "reasoning": true, "input": { "text": true } },',
      '  "variants": {',
      '    "low": { "reasoningEffort": "low" },',
      '    "medium": { "reasoningEffort": "medium" },',
      '    "high": { "reasoningEffort": "high" }',
      '  }',
      '}',
      'openai/text-only',
      '{',
      '  "id": "text-only",',
      '  "providerID": "openai",',
      '  "name": "Text Only",',
      '  "capabilities": { "toolcall": false, "input": { "text": true } }',
      '}',
    ].join('\n');

    expect(buildOpenCodePreflightModelsFromVerboseOutput(raw)).toEqual([{
      id: 'openai/codex-mini-latest',
      name: 'Codex Mini',
      description: 'gpt-codex-mini',
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      }],
    }]);
  });

  it('filters Anthropic models known to be retired even if OpenCode reports them active', () => {
    const raw = [
      'anthropic/claude-3-5-haiku-20241022',
      '{',
      '  "id": "claude-3-5-haiku-20241022",',
      '  "providerID": "anthropic",',
      '  "name": "Claude Haiku 3.5",',
      '  "family": "claude-haiku",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "input": { "text": true } }',
      '}',
      'anthropic/claude-haiku-4-5-20251001',
      '{',
      '  "id": "claude-haiku-4-5-20251001",',
      '  "providerID": "anthropic",',
      '  "name": "Claude Haiku 4.5",',
      '  "family": "claude-haiku",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "input": { "text": true } }',
      '}',
    ].join('\n');

    expect(buildOpenCodePreflightModelsFromVerboseOutput(raw, {
      nowMs: Date.UTC(2026, 5, 6),
    })).toEqual([{
      id: 'anthropic/claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5',
      description: 'claude-haiku',
    }]);
  });

  it('declares session-control probe facts and the verbose model probe', () => {
    expect(OPENCODE_PREFLIGHT_SESSION_CONTROLS).toEqual({
      failureCacheStrategy: 'cooldown',
      probeModelsRaw: expect.any(Function),
      cliModelsCommandArgs: ['models'],
      verboseModelsCommandArgs: ['models', '--verbose'],
    });
  });

  it('probes verbose models through the binary-safe agent CLI exec path', async () => {
    const raw = [
      'openai/codex-mini-latest',
      '{',
      '  "id": "codex-mini-latest",',
      '  "providerID": "openai",',
      '  "name": "Codex Mini",',
      '  "family": "gpt-codex-mini",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "reasoning": true, "input": { "text": true } },',
      '  "variants": {',
      '    "medium": { "reasoningEffort": "medium" }',
      '  }',
      '}',
    ].join('\n');
    const fixture = createExecRunFixture({ stdout: raw });
    const probeModelsRaw = readProbeModelsRaw(OPENCODE_PREFLIGHT_SESSION_CONTROLS);

    expect(probeModelsRaw).toBeTypeOf('function');
    if (!probeModelsRaw) throw new Error('OpenCode preflight model probe is missing');

    await expect(probeModelsRaw({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 1_500,
      env: {
        CI: '0',
        OPENAI_API_KEY: 'sk-test',
        OPENCODE_CONFIG_DIR: '/tmp/opencode',
        IGNORED_UNDEFINED_VALUE: undefined,
      },
    })).resolves.toEqual([{
      id: 'openai/codex-mini-latest',
      name: 'Codex Mini',
      description: 'gpt-codex-mini',
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Thinking',
        type: 'select',
        currentValue: 'medium',
        options: [
          { value: 'medium', name: 'Medium' },
        ],
      }],
    }]);
    expect(fixture.runs).toEqual([{
      input: {
        kind: 'agent-cli',
        agentId: 'opencode',
        args: ['models', '--verbose'],
        cwd: '/workspace',
        env: {
          CI: '1',
          OPENAI_API_KEY: 'sk-test',
          OPENCODE_CONFIG_DIR: '/tmp/opencode',
        },
      },
      options: { timeoutMs: 120_000 },
    }]);
  });

  it('uses an OpenCode-specific timeout floor for slow model discovery', async () => {
    const raw = [
      'opencode/big-pickle',
      '{',
      '  "id": "big-pickle",',
      '  "providerID": "opencode",',
      '  "name": "Big Pickle",',
      '  "family": "big-pickle",',
      '  "status": "active",',
      '  "capabilities": { "toolcall": true, "input": { "text": true } }',
      '}',
    ].join('\n');
    const fixture = createExecRunFixture({ stdout: raw });
    const probeModelsRaw = readProbeModelsRaw(OPENCODE_PREFLIGHT_SESSION_CONTROLS);

    expect(probeModelsRaw).toBeTypeOf('function');
    if (!probeModelsRaw) throw new Error('OpenCode preflight model probe is missing');

    await expect(probeModelsRaw({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 1_500,
    })).resolves.toEqual([{
      id: 'opencode/big-pickle',
      name: 'Big Pickle',
      description: 'big-pickle',
    }]);
    expect(fixture.runs[0]?.options).toEqual({ timeoutMs: 120_000 });
  });

  it('falls back to the plain model list when verbose probing is unavailable', async () => {
    const fixture = createExecRunFixture({
      results: [
        {
          exitCode: 1,
          stdout: 'openai/codex-mini-latest\n{}',
          stderr: 'boom',
        },
        {
          stdout: [
            'opencode/big-pickle',
            'openai/gpt-5.5',
            'not-a-model-id',
          ].join('\n'),
        },
      ],
    });
    const probeModelsRaw = readProbeModelsRaw(OPENCODE_PREFLIGHT_SESSION_CONTROLS);

    expect(probeModelsRaw).toBeTypeOf('function');
    if (!probeModelsRaw) throw new Error('OpenCode preflight model probe is missing');

    await expect(probeModelsRaw({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 1_500,
    })).resolves.toEqual([
      { id: 'opencode/big-pickle', name: 'opencode/big-pickle' },
      { id: 'openai/gpt-5.5', name: 'openai/gpt-5.5' },
    ]);
    expect(fixture.runs.map((run) => run.input.args)).toEqual([
      ['models', '--verbose'],
      ['models'],
    ]);
  });

  it('treats failed verbose and plain model probes as unavailable instead of using partial output', async () => {
    const fixture = createExecRunFixture({
      results: [
        {
          exitCode: 1,
          stdout: 'openai/codex-mini-latest\n{}',
          stderr: 'verbose boom',
        },
        {
          exitCode: 1,
          stdout: 'openai/codex-mini-latest',
          stderr: 'plain boom',
        },
      ],
    });
    const probeModelsRaw = readProbeModelsRaw(OPENCODE_PREFLIGHT_SESSION_CONTROLS);

    expect(probeModelsRaw).toBeTypeOf('function');
    if (!probeModelsRaw) throw new Error('OpenCode preflight model probe is missing');

    await expect(probeModelsRaw({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 1_500,
    })).resolves.toBeNull();
    expect(fixture.runs.map((run) => run.input.args)).toEqual([
      ['models', '--verbose'],
      ['models'],
    ]);
  });
});
