import { describe, expect, it } from 'vitest';

import {
  vendorSessionIdBinding,
  readVendorSessionIdSessionState,
  writeVendorSessionIdSessionState,
} from './vendorSessionId.js';

describe('vendorSessionId session-state binding', () => {
  it('projects provider session ids through provider-owned runtime descriptor readers', () => {
    expect(readVendorSessionIdSessionState({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'oc-descriptor-session',
        },
      },
    })).toEqual({
      value: 'oc-descriptor-session',
      updatedAt: null,
    });
  });

  it('falls back to legacy top-level provider resume marker keys', () => {
    expect(readVendorSessionIdSessionState({
      codexSessionId: ' codex-thread ',
    })).toEqual({
      value: 'codex-thread',
      updatedAt: null,
    });
  });

  it('writes legacy top-level resume marker keys without changing descriptor carriers', () => {
    const metadata = {
      path: '/tmp/project',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'descriptor-thread',
        },
      },
    } as const;

    expect(writeVendorSessionIdSessionState(metadata, {
      metadataKey: 'codexSessionId',
      value: 'legacy-thread',
    })).toEqual({
      ...metadata,
      codexSessionId: 'legacy-thread',
    });
  });

  it('trims blank provider session ids and preserves previous metadata', () => {
    expect(writeVendorSessionIdSessionState({
      path: '/tmp/project',
      codexSessionId: 'previous-thread',
    }, {
      metadataKey: 'codexSessionId',
      value: '   ',
    })).toEqual({
      path: '/tmp/project',
      codexSessionId: 'previous-thread',
    });
  });

  it('generic binding writes the provider marker selected by runtimeDescriptorV1', () => {
    const next = vendorSessionIdBinding.write({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'old-session',
        },
      },
    }, {
      value: 'new-session',
    });

    expect(next).toMatchObject({
      opencodeSessionId: 'new-session',
    });
  });

  it('generic binding can write an explicit provider-owned metadata key', () => {
    const next = vendorSessionIdBinding.write({
      path: '/tmp/project',
    }, {
      value: {
        metadataKey: 'kimiSessionId',
        value: 'kimi-session',
      },
    });

    expect(next).toMatchObject({
      path: '/tmp/project',
      kimiSessionId: 'kimi-session',
    });
  });

  it('rejects arbitrary structured metadata keys outside manifest-declared vendor resume fields', () => {
    const metadata = { path: '/tmp/project' };
    const next = vendorSessionIdBinding.write(metadata, {
      value: {
        metadataKey: 'notARegisteredResumeField',
        value: 'session-id',
      },
    });

    expect(next).toBe(metadata);
  });

  it('derives generic provider resume marker keys from the agent manifest', () => {
    const next = vendorSessionIdBinding.write({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'gemini',
        provider: {
          backendMode: 'shell',
          vendorSessionId: 'old-session',
        },
      },
    }, {
      value: 'gemini-session',
    });

    expect(next).toMatchObject({
      geminiSessionId: 'gemini-session',
    });
  });
});
