import { describe, expect, it } from 'vitest';

import { buildOpenCodeSessionEnvironmentVariables, readOpenCodeSessionAffinityFromMetadata } from './opencodeSessionAffinity';

describe('readOpenCodeSessionAffinityFromMetadata', () => {
  it('prefers agentRuntimeDescriptorV1 over legacy metadata', () => {
    expect(readOpenCodeSessionAffinityFromMetadata({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'oc_1',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      },
      opencodeBackendMode: 'acp',
    })).toEqual({
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });
  });
});

describe('buildOpenCodeSessionEnvironmentVariables', () => {
  it('does not mark inferred server base urls as explicit', () => {
    expect(buildOpenCodeSessionEnvironmentVariables({
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096',
    })).toEqual({
      HAPPIER_OPENCODE_BACKEND_MODE: 'server',
      HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
    });
  });

  it('marks explicit server base urls when requested', () => {
    expect(buildOpenCodeSessionEnvironmentVariables({
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:4096',
      serverBaseUrlExplicit: true,
    })).toEqual({
      HAPPIER_OPENCODE_BACKEND_MODE: 'server',
      HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
      HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
    });
  });
});
