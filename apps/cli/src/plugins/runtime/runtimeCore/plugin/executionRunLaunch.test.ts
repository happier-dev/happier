import { describe, expect, it } from 'vitest';

import { buildPluginExecutionRunLaunchParams } from './executionRunLaunch';

describe('buildPluginExecutionRunLaunchParams', () => {
  it('strips host-only execution-run startup fields before plugin launch', () => {
    expect(buildPluginExecutionRunLaunchParams({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      modelId: 'sample-model',
      permissionMode: 'read_only',
      initialPrompt: 'boot',
      accountSettings: { hostOnly: true },
      start: {
        intent: 'plan',
        retentionPolicy: 'ephemeral',
      },
    })).toEqual({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      modelId: 'sample-model',
      permissionMode: 'read_only',
      initialPrompt: 'boot',
    });
  });

  it('forwards isolation env into plugin launch params (parity with the catalog backend path)', () => {
    expect(buildPluginExecutionRunLaunchParams({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      permissionMode: 'read_only',
      env: {
        CODEX_HOME: '/materialized/run_1/codex-home',
        IGNORED_NON_STRING: 42,
      },
    })).toEqual({
      cwd: '/tmp/plugin-backend',
      backendId: 'acme.sample.backend',
      permissionMode: 'read_only',
      env: {
        CODEX_HOME: '/materialized/run_1/codex-home',
      },
    });
  });
});
