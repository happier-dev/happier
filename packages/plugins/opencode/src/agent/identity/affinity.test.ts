import { describe, expect, it } from 'vitest';

import {
  applyOpenCodeSessionAffinityMetadata,
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
} from './affinity.js';

describe('OpenCode session affinity metadata', () => {
  it('builds launch environment variables from affinity values', () => {
    expect(buildOpenCodeSessionEnvironmentVariables({
      backendMode: 'server',
      serverBaseUrl: 'http://127.0.0.1:49196',
      serverBaseUrlExplicit: true,
    })).toEqual({
      HAPPIER_OPENCODE_BACKEND_MODE: 'server',
      HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:49196',
      HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
    });
  });

  it('writes provider session and runtime affinity metadata', () => {
    expect(applyOpenCodeSessionAffinityMetadata({
      backendMode: 'server',
      providerSessionId: ' oc-session ',
      serverBaseUrl: 'http://127.0.0.1:49196',
      serverBaseUrlExplicit: true,
    })).toEqual({
      opencodeSessionId: 'oc-session',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:49196',
      opencodeServerBaseUrlExplicit: true,
    });
  });

  it('reads affinity from legacy metadata for transitional sessions', () => {
    expect(readOpenCodeSessionAffinityFromMetadata({
      opencodeBackendMode: 'acp',
      opencodeServerBaseUrl: 'http://localhost:4096',
      opencodeServerBaseUrlExplicit: true,
    })).toEqual({
      backendMode: 'acp',
      serverBaseUrl: 'http://localhost:4096/',
      serverBaseUrlExplicit: true,
    });
  });
});
