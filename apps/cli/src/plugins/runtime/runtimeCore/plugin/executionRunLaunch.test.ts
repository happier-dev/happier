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
});
