import { describe, expect, it } from 'vitest';

import {
  readLegacyAgentRuntimeDescriptorV1,
  readLegacyAgentRuntimeDescriptorV1FromMetadata,
  LegacyAgentRuntimeDescriptorV1Schema,
  readRuntimeDescriptorV1FromMetadata,
  writeRuntimeDescriptorV1ToMetadata,
} from './runtimeDescriptorMetadata.js';

describe('runtimeDescriptorMetadata compat helpers', () => {
  it('prefers runtimeDescriptorV1 over legacy agentRuntimeDescriptorV1 carriers', () => {
    expect(readRuntimeDescriptorV1FromMetadata({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'canonical-thread',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    })).toEqual({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        providerSessionId: 'canonical-thread',
      },
    });
  });

  it('falls back to legacy agentRuntimeDescriptorV1 carriers when runtimeDescriptorV1 is absent', () => {
    expect(readRuntimeDescriptorV1FromMetadata({
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'pi',
        provider: {
          resumeStrategy: 'sessionFileBySessionId',
        },
      },
    })).toEqual({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileBySessionId',
      },
    });
  });

  it('keeps legacy agentRuntimeDescriptorV1 parsing behind an explicit compat helper', () => {
    expect(readLegacyAgentRuntimeDescriptorV1({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileBySessionId',
      },
    })).toEqual({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileBySessionId',
      },
    });

    expect(readLegacyAgentRuntimeDescriptorV1FromMetadata({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
        },
      },
    })).toEqual({
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'acp',
      },
    });

    expect(LegacyAgentRuntimeDescriptorV1Schema.safeParse({
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'server',
      },
    }).success).toBe(true);
  });

  it('writes canonical runtimeDescriptorV1 metadata without mirroring the legacy alias by default', () => {
    expect(writeRuntimeDescriptorV1ToMetadata({
      path: '/tmp/session',
      host: 'localhost',
      agentRuntimeCapabilitiesV1: { executionRun: { supported: true } },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'legacy-oc',
        },
      },
    }, {
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'server',
        providerSessionId: 'oc-1',
      },
    })).toEqual({
      path: '/tmp/session',
      host: 'localhost',
      agentRuntimeCapabilitiesV1: { executionRun: { supported: true } },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'legacy-oc',
        },
      },
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'oc-1',
        },
      },
    });
  });

  it('mirrors the legacy alias only when bounded compat explicitly opts in', () => {
    expect(writeRuntimeDescriptorV1ToMetadata({
      path: '/tmp/session',
      host: 'localhost',
    }, {
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'server',
        providerSessionId: 'oc-1',
      },
    }, {
      mirrorLegacyAgentRuntimeDescriptorV1: true,
    })).toEqual({
      path: '/tmp/session',
      host: 'localhost',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'oc-1',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'oc-1',
        },
      },
    });
  });

  it('removes canonical runtime descriptor metadata and preserves the legacy read alias when clearing the descriptor', () => {
    expect(writeRuntimeDescriptorV1ToMetadata({
      path: '/tmp/session',
      host: 'localhost',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer' },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'acp' },
      },
    }, null)).toEqual({
      path: '/tmp/session',
      host: 'localhost',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'acp' },
      },
    });
  });
});
