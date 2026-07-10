import { describe, expect, it } from 'vitest';
import type {
  ExecLaunchInputV1,
  ExecRunOptionsV1,
  ExecRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import {
  ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS,
  buildAntigravityPreflightModelsFromModelsOutput,
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
        throw new Error('system tools should not be used for Antigravity model preflight');
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
      throw new Error('spawn should not be used for Antigravity model preflight');
    },
    spawnClient: (async () => {
      throw new Error('spawnClient should not be used for Antigravity model preflight');
    }) as ExecRuntimeServiceV1['spawnClient'],
  };
  return { exec, runs };
}

describe('Antigravity preflight model parsing', () => {
  it('parses the observed agy models output into provider-owned model descriptors', () => {
    expect(buildAntigravityPreflightModelsFromModelsOutput([
      '  Gemini 3.5 Flash (Medium)',
      '  Gemini 3.5 Flash (High)',
      '  Gemini 3.5 Flash (Low)',
      '  Gemini 3.1 Pro (Low)',
      '  Gemini 3.1 Pro (High)',
      '  Claude Sonnet 4.6 (Thinking)',
      '  Claude Opus 4.6 (Thinking)',
      '  GPT-OSS 120B (Medium)',
    ].join('\n'))).toEqual([
      { id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)' },
      { id: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)' },
      { id: 'Gemini 3.5 Flash (Low)', name: 'Gemini 3.5 Flash (Low)' },
      { id: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)' },
      { id: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)' },
      { id: 'Claude Sonnet 4.6 (Thinking)', name: 'Claude Sonnet 4.6 (Thinking)' },
      { id: 'Claude Opus 4.6 (Thinking)', name: 'Claude Opus 4.6 (Thinking)' },
      { id: 'GPT-OSS 120B (Medium)', name: 'GPT-OSS 120B (Medium)' },
    ]);
  });

  it('returns null for empty or non-model output', () => {
    expect(buildAntigravityPreflightModelsFromModelsOutput('')).toBeNull();
    expect(buildAntigravityPreflightModelsFromModelsOutput('No models available\n')).toBeNull();
  });

  it('probes agy models through the binary-safe agent CLI exec path', async () => {
    const fixture = createExecRunFixture({
      stdout: [
        'Gemini 3.5 Flash (Medium)',
        'Claude Sonnet 4.6 (Thinking)',
      ].join('\n'),
    });

    await expect(ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS.probeModelsRaw?.({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 1_500,
        env: {
          CI: '0',
          HAPPIER_ANTIGRAVITY_RUNTIME_MODE: 'cliPrint',
          GEMINI_API_KEY: 'secret',
          GOOGLE_APPLICATION_CREDENTIALS: '/private/credentials.json',
          EMPTY_VALUE: undefined,
        },
    })).resolves.toEqual([
      { id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)' },
      { id: 'Claude Sonnet 4.6 (Thinking)', name: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
    expect(fixture.runs).toEqual([{
      input: {
        kind: 'agent-cli',
        agentId: 'antigravity',
        args: ['models'],
        cwd: '/workspace',
        env: {
          CI: '1',
        },
      },
      options: {
        maxStderrBytes: 262_144,
        maxStdoutBytes: 262_144,
        timeoutMs: 1_500,
      },
    }]);
  });

  it('treats failed agy models probes as unavailable instead of parsing partial output', async () => {
    const fixture = createExecRunFixture({
      exitCode: 1,
      stdout: 'Gemini 3.5 Flash (Medium)',
      stderr: 'auth unavailable',
    });

    await expect(ANTIGRAVITY_PREFLIGHT_SESSION_CONTROLS.probeModelsRaw?.({
      exec: fixture.exec,
      cwd: '/workspace',
      timeoutMs: 1_500,
    })).resolves.toBeNull();
  });
});
