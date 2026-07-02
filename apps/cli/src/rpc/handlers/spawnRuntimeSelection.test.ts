import { describe, expect, it } from 'vitest';

import { readCanonicalSpawnRuntimeSelectionFromCompatIngress } from './spawnRuntimeSelection';

describe('readCanonicalSpawnRuntimeSelectionFromCompatIngress', () => {
  it('prefers canonical runtimeDescriptorV1 over the legacy ingress carrier', () => {
    expect(readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'mcp',
          providerSessionId: 'canonical-thread',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: {
              backendMode: 'appServer',
              providerSessionId: 'canonical-affinity',
            },
          },
        },
      },
      legacyAgentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    })).toEqual({
      codexBackendMode: 'appServer',
      providerRuntimeSelection: {
        codexBackendMode: 'appServer',
      },
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'mcp',
          providerSessionId: 'canonical-thread',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: {
              backendMode: 'appServer',
              providerSessionId: 'canonical-affinity',
            },
          },
        },
      },
    });
  });

  it('falls back to the legacy ingress carrier when the canonical carrier is invalid', () => {
    expect(readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 42,
        provider: {
          backendMode: 'appServer',
        },
      },
      legacyAgentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    })).toEqual({
      codexBackendMode: 'acp',
      providerRuntimeSelection: {
        codexBackendMode: 'acp',
      },
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    });
  });
});
