import { describe, expect, it } from 'vitest';

import { createSessionStateFieldMetadataUpdater } from './publishField.js';
import {
  readRuntimeDescriptorSessionState,
  writeRuntimeDescriptorSessionState,
} from './runtimeDescriptor.js';

describe('runtimeDescriptor session-state binding', () => {
  it('reads canonical runtimeDescriptorV1 before the legacy agentRuntimeDescriptorV1 fallback', () => {
    expect(readRuntimeDescriptorSessionState({
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
        agentId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'legacy-session',
        },
      },
    })).toEqual({
      value: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'appServer',
          providerSessionId: 'canonical-thread',
        },
      },
      updatedAt: null,
    });
  });

  it('falls back to legacy agentRuntimeDescriptorV1 reads but replaces it on canonical writes', () => {
    const legacyDescriptor = {
      v: 1,
      agentId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileBySessionId',
        providerSessionId: 'pi-session',
      },
    } as const;

    expect(readRuntimeDescriptorSessionState({
      agentRuntimeDescriptorV1: legacyDescriptor,
    })).toEqual({
      value: {
        v: 1,
        agentId: 'pi',
        agent: {
          resumeStrategy: 'sessionFileBySessionId',
          providerSessionId: 'pi-session',
        },
      },
      updatedAt: null,
    });

    expect(writeRuntimeDescriptorSessionState({
      path: '/tmp/project',
      agentRuntimeDescriptorV1: legacyDescriptor,
    }, {
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'oc-session',
      },
    })).toEqual({
      path: '/tmp/project',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'oc-session',
        },
      },
    });
  });

  it('clears canonical and legacy descriptor metadata through the binding', () => {
    expect(writeRuntimeDescriptorSessionState({
      path: '/tmp/project',
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
      path: '/tmp/project',
    });
  });

  it('clears a descriptor through the generic session-state metadata updater', () => {
    const updater = createSessionStateFieldMetadataUpdater('identity.runtimeDescriptor', null);

    expect(updater({
      path: '/tmp/project',
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
    })).toEqual({
      path: '/tmp/project',
    });
  });
});
