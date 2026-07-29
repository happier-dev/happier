import { describe, expect, it } from 'vitest';

import { createPluginExecService } from '../exec/hostService';

describe('plugin exec scoped environment', () => {
  it('applies unset keys at the final binary spawn while preserving explicit empty values', async () => {
    const exec = createPluginExecService({
      allowedExecutablePaths: [process.execPath],
      allowPathRuntimeNames: ['node'],
      baseEnv: {
        PATH: process.env.PATH ?? '',
        OPENAI_API_KEY: 'ambient-key',
        Gemini_Model: 'ambient-model',
        CLAUDECODE: '1',
        HAPPIER_DAEMON_RUNTIME_ID: 'runtime-parent',
        HAPPIER_SESSION_PROFILE_ID: 'ambient-profile',
        HAPPIER_SESSION_ATTACH_FILE: '/tmp/ambient-attach.json',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'ambient-selections',
      },
    });

    const result = await exec.run({
      kind: 'binary',
      executablePath: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ key: process.env.OPENAI_API_KEY ?? null, model: process.env.Gemini_Model ?? null, empty: process.env.EMPTY ?? null, nested: process.env.CLAUDECODE ?? null, daemonRuntime: process.env.HAPPIER_DAEMON_RUNTIME_ID ?? null, profile: process.env.HAPPIER_SESSION_PROFILE_ID ?? null, attach: process.env.HAPPIER_SESSION_ATTACH_FILE ?? null, selections: process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON ?? null }))'],
      env: {
        Gemini_Model: 'explicit-model',
        EMPTY: '',
        HAPPIER_SESSION_PROFILE_ID: 'plugin-spoof',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'plugin-spoof',
      },
      unsetEnvKeys: ['openai_api_key', 'GEMINI_MODEL'],
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      key: null,
      model: 'explicit-model',
      empty: '',
      nested: null,
      daemonRuntime: null,
      profile: null,
      attach: null,
      selections: null,
    });
  });
});
