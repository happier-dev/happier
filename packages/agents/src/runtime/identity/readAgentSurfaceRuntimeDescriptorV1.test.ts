import { describe, expect, it } from 'vitest';

import { readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata } from './readAgentSurfaceRuntimeDescriptorV1.js';

describe('readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata', () => {
  it('re-envelopes the declared predecessor OpenCode fields through the generated reader', () => {
    expect(readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata({
      flavor: 'opencode',
      opencodeBackendMode: 'server',
      opencodeSessionId: ' opencode-legacy-1 ',
      opencodeServerBaseUrl: 'http://127.0.0.1:49196/path?ignored=true',
      opencodeServerBaseUrlExplicit: true,
    })).toEqual({
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'opencode-legacy-1',
        serverBaseUrl: 'http://127.0.0.1:49196/',
        serverBaseUrlExplicit: true,
      },
    });
  });

  it('uses the existing canonical runtime descriptor unchanged before consulting legacy fields', () => {
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'opencode',
      agent: {
        backendMode: 'acp',
        providerSessionId: 'canonical-session',
      },
    };

    expect(readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata({
      flavor: 'opencode',
      runtimeDescriptorV1,
      opencodeBackendMode: 'server',
      opencodeSessionId: 'legacy-session',
    })).toEqual(runtimeDescriptorV1);
  });
});
