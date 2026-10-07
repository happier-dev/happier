import { describe, expect, it } from 'vitest';

import {
  resolveOpenCodeAttachReachability,
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
    expect(createOpenCodeAttachArgs(target.value, { cliVersion: '1.18.25' })).toEqual([
      'attach',
      'http://127.0.0.1:49196/',
      '--dir',
      '/repo',
      '--session',
      'oc-session-1',
    ]);
    expect(resolveOpenCodeAttachReachability(target.value, { cliVersion: '1.18.25' })).toEqual({
      kind: 'http',
      url: 'http://127.0.0.1:49196/global/health',
    });
  });

  it.each(['2.0.15', 'opencode v2.0.20'])('uses the released OpenCode 2 root-command contract and info route (%s)', (cliVersion) => {
    const target = resolveOpenCodeAttachTarget({ metadata });
    if (!target.ok) throw new Error('expected attach target');

    expect(createOpenCodeAttachArgs(target.value, { cliVersion })).toEqual([
      '--server',
      'http://127.0.0.1:49196/',
      '--session',
      'oc-session-1',
      '/repo',
    ]);
    expect(resolveOpenCodeAttachReachability(target.value, { cliVersion })).toEqual({
      kind: 'http',
      url: 'http://127.0.0.1:49196/api/info',
    });
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
