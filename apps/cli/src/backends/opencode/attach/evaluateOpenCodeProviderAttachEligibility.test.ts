import { describe, expect, it } from 'vitest';

import {
  evaluateOpenCodeProviderAttachEligibility,
  resolveOpenCodeProviderAttachTarget,
  resolveOpenCodeProviderAttachTargetWithManagedServerFallback,
} from './evaluateOpenCodeProviderAttachEligibility';

const validServerMetadata = {
  flavor: 'opencode',
  path: '/tmp/opencode-workspace',
  opencodeSessionId: 'opencode-session-1',
  opencodeBackendMode: 'server',
  opencodeServerBaseUrl: 'https://opencode.example.test/',
  opencodeServerBaseUrlExplicit: true,
};

describe('OpenCode provider attach eligibility', () => {
  it('resolves server-backed OpenCode attach targets from vendor session, path, mode, and server URL metadata', () => {
    expect(resolveOpenCodeProviderAttachTarget(validServerMetadata)).toEqual({
      eligible: true,
      vendorSessionId: 'opencode-session-1',
      directory: '/tmp/opencode-workspace',
      baseUrl: 'https://opencode.example.test/',
    });
  });

  it('rejects OpenCode attach when vendor session id metadata is missing', () => {
    expect(evaluateOpenCodeProviderAttachEligibility({
      ...validServerMetadata,
      opencodeSessionId: undefined,
    })).toMatchObject({
      eligible: false,
    });
  });

  it('rejects OpenCode attach when working directory path metadata is missing', () => {
    expect(evaluateOpenCodeProviderAttachEligibility({
      ...validServerMetadata,
      path: undefined,
    })).toMatchObject({
      eligible: false,
    });
  });

  it('rejects OpenCode attach for non-server backend modes', () => {
    expect(evaluateOpenCodeProviderAttachEligibility({
      ...validServerMetadata,
      opencodeBackendMode: 'acp',
    })).toMatchObject({
      eligible: false,
    });
  });

  it('rejects OpenCode attach when server URL metadata is missing', () => {
    expect(evaluateOpenCodeProviderAttachEligibility({
      ...validServerMetadata,
      opencodeServerBaseUrl: undefined,
      opencodeServerBaseUrlExplicit: undefined,
    })).toMatchObject({
      eligible: false,
    });
  });

  it('uses managed server fallback only when resolving a local attach target', async () => {
    const readManagedServerStateFn = async () => ({
      baseUrl: 'http://127.0.0.1:4096/',
      pid: 12345,
      startedAtMs: 123,
      status: 'ready' as const,
    });

    await expect(resolveOpenCodeProviderAttachTargetWithManagedServerFallback({
      metadata: {
        ...validServerMetadata,
        opencodeServerBaseUrl: undefined,
        opencodeServerBaseUrlExplicit: undefined,
      },
      readManagedServerStateFn,
    })).resolves.toEqual({
      eligible: true,
      vendorSessionId: 'opencode-session-1',
      directory: '/tmp/opencode-workspace',
      baseUrl: 'http://127.0.0.1:4096/',
    });
  });
});
