import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeAttachHealthUrl,
  createOpenCodeAttachArgs,
  resolveOpenCodeAttachTarget,
} from './descriptor.js';

const metadata = {
  path: '/repo',
  runtimeDescriptorV1: {
    v: 1 as const,
    agentId: 'opencode',
    agent: {
      backendMode: 'server',
      providerSessionId: 'oc-session-1',
      serverBaseUrl: 'http://127.0.0.1:49196/',
      serverBaseUrlExplicit: true,
    },
  },
};

describe('OpenCode attach descriptor', () => {
  it('resolves server-backed attach target metadata and builds provider attach args', () => {
    const target = resolveOpenCodeAttachTarget({ metadata });

    expect(target).toEqual({
      ok: true,
      value: {
        providerSessionId: 'oc-session-1',
        directory: '/repo',
        baseUrl: 'http://127.0.0.1:49196/',
      },
    });
    if (!target.ok) throw new Error('expected attach target');
    expect(createOpenCodeAttachArgs(target.value)).toEqual([
      'attach',
      'http://127.0.0.1:49196/',
      '--dir',
      '/repo',
      '--session',
      'oc-session-1',
    ]);
    expect(buildOpenCodeAttachHealthUrl(target.value)).toBe(
      'http://127.0.0.1:49196/global/health',
    );
  });

  it('uses the host-owned managed Session endpoint fallback without overriding an explicit URL', () => {
    const managedMetadata = {
      ...metadata,
      runtimeDescriptorV1: {
        ...metadata.runtimeDescriptorV1,
        agent: {
          ...metadata.runtimeDescriptorV1.agent,
          serverBaseUrl: undefined,
          serverBaseUrlExplicit: false,
        },
      },
    };
    expect(resolveOpenCodeAttachTarget({
      metadata: managedMetadata,
      fallbackServerBaseUrl: 'http://127.0.0.1:49197',
    })).toMatchObject({
      ok: true,
      value: { baseUrl: 'http://127.0.0.1:49197' },
    });
    expect(resolveOpenCodeAttachTarget({
      metadata,
      fallbackServerBaseUrl: 'http://127.0.0.1:49197',
    })).toMatchObject({
      ok: true,
      value: { baseUrl: 'http://127.0.0.1:49196/' },
    });
  });
});
