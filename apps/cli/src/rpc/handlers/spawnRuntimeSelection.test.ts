import { describe, expect, it } from 'vitest';

import {
  readCanonicalSpawnRuntimeSelectionFromCompatIngress,
} from './spawnRuntimeSelection';

describe('readCanonicalSpawnRuntimeSelectionFromCompatIngress', () => {
  it('does not interpret an opaque current Agent descriptor to compare a legacy Codex hint', () => {
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'codex',
      agent: {
        backendMode: 'future-plugin-owned-mode',
        nested: { preserve: true },
      },
    };

    expect(readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      agentId: 'codex',
      codexBackendMode: 'acp',
      runtimeDescriptorV1,
    })).toEqual({ runtimeDescriptorV1 });
  });

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
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
      },
    });
  });

  it('carries non-Codex runtime descriptors opaquely without host interpretation', () => {
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

  it('normalizes predecessor vocabulary without interpreting Agent payloads', () => {
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

  it('rejects a runtime descriptor that does not match the selected Agent', () => {
    expect(() => readCanonicalSpawnRuntimeSelectionFromCompatIngress({
      agentId: 'opencode',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: {},
      },
    })).toThrow(/must match the selected Agent/);
  });
});
