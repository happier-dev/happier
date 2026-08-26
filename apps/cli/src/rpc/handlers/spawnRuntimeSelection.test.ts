import { describe, expect, it } from 'vitest';

import { readCanonicalSpawnRuntimeSelectionFromCompatIngress } from './spawnRuntimeSelection';

describe('readCanonicalSpawnRuntimeSelectionFromCompatIngress', () => {
  it('prefers canonical runtimeDescriptorV1 over the legacy ingress carrier', () => {
    expect(readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'mcp',
          providerSessionId: 'canonical-thread',
          agentExtra: {
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
        agentId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    })).toEqual({
      codexBackendMode: 'appServer',
      agentBackendMode: 'appServer',
      agentRuntimeSelection: {
        codexBackendMode: 'appServer',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'mcp',
          providerSessionId: 'canonical-thread',
          agentExtra: {
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
        agentId: 42,
        provider: {
          backendMode: 'appServer',
        },
      },
      legacyAgentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    })).toEqual({
      codexBackendMode: 'acp',
      agentBackendMode: 'acp',
      agentRuntimeSelection: {
        codexBackendMode: 'acp',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {
          backendMode: 'acp',
          providerSessionId: 'legacy-thread',
        },
      },
    });
  });

  it('normalizes legacy Codex mcp mode to the canonical appServer runtime selection', () => {
    expect(readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      codexBackendMode: 'mcp',
    })).toEqual({
      codexBackendMode: 'appServer',
      agentRuntimeSelection: {
        codexBackendMode: 'appServer',
      },
    });
  });

  it('prefers the canonical Codex backendMode over a stale legacy codexBackendMode', () => {
    expect(readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      backendMode: 'appServer',
      codexBackendMode: 'acp',
    })).toEqual({
      codexBackendMode: 'appServer',
      agentRuntimeSelection: {
        codexBackendMode: 'appServer',
      },
    });
  });

  it('projects runtime mode selections from non-Codex provider runtime descriptors', () => {
    expect(readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'opencode-thread',
        },
      },
    })).toEqual({
      agentBackendMode: 'server',
      agentRuntimeSelection: {
        opencodeBackendMode: 'server',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'opencode-thread',
        },
      },
    });
  });

  it('projects Antigravity persisted runtime mode through the generated host owner', () => {
    expect(readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'antigravity',
        provider: {
          runtimeMode: 'cliPrint',
          providerSessionId: 'stale-cli-conversation',
          providerExtra: {
            owner: 'antigravity',
            schemaId: 'antigravity.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeHandle: {
              runtimeMode: 'sdk',
              providerSessionId: 'localharness-session-1',
              localharnessSessionId: 'localharness-session-1',
            },
          },
        },
      },
    })).toEqual({
      agentBackendMode: 'sdk',
      agentRuntimeSelection: {
        antigravityRuntimeMode: 'sdk',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'antigravity',
        agent: {
          runtimeMode: 'cliPrint',
          providerSessionId: 'stale-cli-conversation',
          agentExtra: {
            owner: 'antigravity',
            schemaId: 'antigravity.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeHandle: {
              runtimeMode: 'sdk',
              providerSessionId: 'localharness-session-1',
              localharnessSessionId: 'localharness-session-1',
            },
          },
        },
      },
    });
  });
});
