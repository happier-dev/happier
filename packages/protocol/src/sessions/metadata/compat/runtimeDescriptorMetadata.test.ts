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
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'canonical-thread',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    })).toEqual({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'canonical-thread',
      },
    });
  });

  it('falls back to legacy agentRuntimeDescriptorV1 carriers when runtimeDescriptorV1 is absent', () => {
    expect(readRuntimeDescriptorV1FromMetadata({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'pi',
        provider: {
          resumeStrategy: 'sessionFileBySessionId',
        },
      },
    })).toEqual({
      v: 1,
      agentId: 'pi',
      agent: {
        resumeStrategy: 'sessionFileBySessionId',
      },
    });
  });

  it('normalizes the deployed providerId envelope on either metadata carrier', () => {
    expect(readRuntimeDescriptorV1FromMetadata({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'appServer' },
      },
    })).toEqual({
      v: 1,
      agentId: 'codex',
      agent: { backendMode: 'appServer' },
    });
  });

  it('fails closed when canonical and deployed identity fields conflict', () => {
    expect(readLegacyAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'codex',
      providerId: 'opencode',
      provider: { backendMode: 'appServer' },
    })).toBeNull();
  });

  it('keeps legacy agentRuntimeDescriptorV1 parsing behind an explicit compat helper', () => {
    expect(readLegacyAgentRuntimeDescriptorV1({
      v: 1,
      agentId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileBySessionId',
      },
    })).toEqual({
      v: 1,
      agentId: 'pi',
      agent: {
        resumeStrategy: 'sessionFileBySessionId',
      },
    });

    expect(readLegacyAgentRuntimeDescriptorV1FromMetadata({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'appServer',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'acp',
        },
      },
    })).toEqual({
      v: 1,
      agentId: 'codex',
      agent: {
        backendMode: 'acp',
      },
    });

    expect(LegacyAgentRuntimeDescriptorV1Schema.safeParse({
      v: 1,
      agentId: 'opencode',
      provider: {
        backendMode: 'server',
      },
    }).data).toEqual({
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
      },
    });
  });

  it('writes canonical runtimeDescriptorV1 metadata without mirroring the legacy alias by default', () => {
    expect(writeRuntimeDescriptorV1ToMetadata({
      path: '/tmp/session',
      host: 'localhost',
      agentRuntimeCapabilitiesV1: { executionRun: { supported: true } },
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'legacy-oc',
        },
      },
    }, {
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'oc-1',
      },
    })).toEqual({
      path: '/tmp/session',
      host: 'localhost',
      agentRuntimeCapabilitiesV1: { executionRun: { supported: true } },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
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
      agentId: 'opencode',
      agent: {
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
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'oc-1',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'oc-1',
        },
      },
    });
  });

  it('removes canonical and legacy runtime descriptor metadata when clearing the descriptor', () => {
    expect(writeRuntimeDescriptorV1ToMetadata({
      path: '/tmp/session',
      host: 'localhost',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: { backendMode: 'appServer' },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: { backendMode: 'acp' },
      },
    }, null)).toEqual({
      path: '/tmp/session',
      host: 'localhost',
    });
  });

  it('writes Oh My Pi metadata with structured identity and no flat identity alias', () => {
    const written = writeRuntimeDescriptorV1ToMetadata({
      path: '/tmp/session',
    }, {
      v: 1,
      agentId: 'ohMyPi',
      agent: {
        backendMode: 'acp',
        providerSessionId: 'omp-session-1',
      },
    });

    expect(written.runtimeDescriptorV1).toEqual({
      v: 1,
      agentIdentity: {
        pluginId: 'happier.agent.ohmypi',
        localId: 'ohmypi',
      },
      agent: {
        backendMode: 'acp',
        providerSessionId: 'omp-session-1',
      },
    });
    expect(written).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(JSON.stringify(written.runtimeDescriptorV1)).not.toContain('ohMyPi');
    expect(readRuntimeDescriptorV1FromMetadata(written)).toMatchObject({
      agentId: 'ohMyPi',
    });
  });
});
