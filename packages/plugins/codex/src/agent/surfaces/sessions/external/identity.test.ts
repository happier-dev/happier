import { describe, expect, it } from 'vitest';

import { resolveCodexExternalSessionLinkIdentity } from './identity.js';

describe('Codex external-session link identity', () => {
  it('resolves canonical runtime descriptor affinity', () => {
    const result = resolveCodexExternalSessionLinkIdentity({
      remoteSessionId: 'fallback-thread',
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/tmp/user-codex-home',
      },
      runtimeDescriptor: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread-from-runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          homePath: '/tmp/connected-codex-home',
        },
      },
      metadata: {
        codexBackendMode: 'acp',
      },
    });

    expect(result).toMatchObject({
      remoteSessionId: 'thread-from-runtime',
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: '/tmp/connected-codex-home',
      },
      vendorMetadata: {
        codexBackendMode: 'appServer',
      },
      externalSessionMetadata: {
        codexBackendMode: 'appServer',
      },
      runtimeDescriptor: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'thread-from-runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'profile-1',
          homePath: '/tmp/connected-codex-home',
        },
      },
    });
  });
});
