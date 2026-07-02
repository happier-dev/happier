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
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'canonical-thread',
        },
      },
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'legacy-session',
        },
      },
    })).toEqual({
      value: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'canonical-thread',
        },
      },
      updatedAt: null,
    });
  });

  it('falls back to legacy agentRuntimeDescriptorV1 reads and preserves that read alias by default', () => {
    const legacyDescriptor = {
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileBySessionId',
        providerSessionId: 'pi-session',
      },
    } as const;

    expect(readRuntimeDescriptorSessionState({
      agentRuntimeDescriptorV1: legacyDescriptor,
    })).toEqual({
      value: legacyDescriptor,
      updatedAt: null,
    });

    expect(writeRuntimeDescriptorSessionState({
      path: '/tmp/project',
      agentRuntimeDescriptorV1: legacyDescriptor,
    }, {
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'server',
        providerSessionId: 'oc-session',
      },
    })).toEqual({
      path: '/tmp/project',
      agentRuntimeDescriptorV1: legacyDescriptor,
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'oc-session',
        },
      },
    });
  });

  it('clears canonical descriptor metadata while preserving the legacy read alias', () => {
    expect(writeRuntimeDescriptorSessionState({
      path: '/tmp/project',
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
      path: '/tmp/project',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'acp' },
      },
    });
  });

  it('clears a descriptor through the generic session-state metadata updater', () => {
    const updater = createSessionStateFieldMetadataUpdater('identity.runtimeDescriptor', null);

    expect(updater({
      path: '/tmp/project',
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
    })).toEqual({
      path: '/tmp/project',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: { backendMode: 'acp' },
      },
    });
  });
});
