import { describe, expect, it } from 'vitest';

import { COPILOT_AUTH_ENV_VARS, COPILOT_GH_AUTH_PROBE } from './copilotAuth.js';

describe('Copilot auth descriptor', () => {
  it('describes host-owned GitHub token probing without executing gh in the plugin', () => {
    expect(COPILOT_AUTH_ENV_VARS).toEqual(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']);
    expect(COPILOT_GH_AUTH_PROBE).toEqual({
      command: 'gh',
      args: ['auth', 'token'],
      timeoutEnvKey: 'HAPPIER_COPILOT_CLI_AUTH_PROBE_TIMEOUT_MS',
      defaultTimeoutMs: 1500,
    });
  });
});
