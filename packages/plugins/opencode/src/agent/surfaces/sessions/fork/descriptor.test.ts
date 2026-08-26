import { describe, expect, it } from 'vitest';

import { resolveOpenCodeReplayChildLaunch } from './descriptor.js';

describe('OpenCode fork descriptor', () => {
  it('interprets the bounded runtime descriptor at the plugin leaf', async () => {
    await expect(resolveOpenCodeReplayChildLaunch({
      parentMetadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'opencode',
          agent: {
            backendMode: 'server',
            providerSessionId: 'oc-parent-1',
            serverBaseUrl: 'http://127.0.0.1:49196/path?ignored=true',
            serverBaseUrlExplicit: true,
          },
        },
      },
    })).resolves.toEqual({
      environmentVariables: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:49196/',
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
      },
    });
  });
});
