import { describe, expect, it } from 'vitest';

import {
  RuntimeDescriptorV1Schema,
  buildCodexRuntimeIdentityDescriptorV1,
  buildOpenCodeRuntimeIdentityDescriptorV1,
  readCanonicalRuntimeDescriptorV1ForProvider,
  readRuntimeDescriptorV1ForProvider,
} from './runtimeDescriptorV1.js';

describe('runtimeDescriptorV1 aliases', () => {
  it('parses runtime descriptors through canonical runtime naming', () => {
    const built = buildCodexRuntimeIdentityDescriptorV1({
      backendMode: 'appServer',
      vendorSessionId: 'thread_1',
    });

    const parsed = RuntimeDescriptorV1Schema.parse({
      ...built,
      futureRuntimeDescriptorFlag: 'keep-me',
    });

    expect(parsed).toMatchObject({
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_1',
      },
    });
    expect((parsed as any).futureRuntimeDescriptorFlag).toBe('keep-me');
  });

  it('reads provider-scoped runtime descriptors through canonical runtime naming', () => {
    const built = buildOpenCodeRuntimeIdentityDescriptorV1({
      backendMode: 'server',
      vendorSessionId: 'sess_1',
      serverBaseUrl: 'http://127.0.0.1:4096/',
      serverBaseUrlExplicit: true,
    });

    expect(readRuntimeDescriptorV1ForProvider(built, 'opencode')).toMatchObject({
      provider: {
        backendMode: 'server',
        vendorSessionId: 'sess_1',
      },
    });
  });

  it('reads canonical runtime descriptor facts through canonical runtime naming', () => {
    expect(readCanonicalRuntimeDescriptorV1ForProvider({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        vendorSessionId: 'thread_1',
      },
    }, 'codex')).toEqual({
      providerId: 'codex',
      backendMode: 'appServer',
      vendorSessionId: 'thread_1',
      home: null,
      connectedServiceId: null,
      connectedServiceProfileId: null,
      homePath: null,
    });
  });
});
