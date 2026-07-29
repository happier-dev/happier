import { describe, expect, it, vi } from 'vitest';

vi.mock('@happier-dev/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/agents')>();
  const shellBridgeAcpAgent = {
    ...actual.AGENTS_CORE.kiro,
    id: 'shellBridgeAcp',
    cliSubcommand: 'shellBridgeAcp',
    tools: {
      ...actual.AGENTS_CORE.kiro.tools,
      delivery: 'shell_bridge',
    },
  } as const;
  const nativeMcpGeminiAgent = {
    ...actual.AGENTS_CORE.gemini,
    tools: {
      ...actual.AGENTS_CORE.gemini.tools,
      delivery: 'native_mcp',
      support: 'supported',
    },
  } as const;

  return {
    ...actual,
    AGENTS_CORE: {
      ...actual.AGENTS_CORE,
      gemini: nativeMcpGeminiAgent,
      shellBridgeAcp: shellBridgeAcpAgent,
    } as unknown as typeof actual.AGENTS_CORE,
  };
});

import { isAcpForkEligibleForAgent } from './acpForkEligibility';

describe('isAcpForkEligibleForAgent', () => {
  it('treats catalog-declared shell-bridge providers as ACP eligible without a hardcoded provider list', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'shellBridgeAcp',
        metadata: {},
      }),
    ).toBe(true);
  });

  it('keeps Gemini ACP fork eligible when its tool delivery is native MCP', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'gemini',
        metadata: {},
      }),
    ).toBe(true);
  });

  it('treats canonical codex runtime metadata as ACP eligibility for codex', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'codex',
        metadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: { backendMode: 'acp', providerSessionId: 'codex_parent' },
          },
          codexSessionId: 'codex_parent',
        },
      }),
    ).toBe(true);
  });

  it('preserves legacy codexRuntimeDescriptorV1 ACP compatibility for codex', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'codex',
        metadata: {
          codexRuntimeDescriptorV1: {
            v: 1,
            backendMode: 'acp',
          },
          codexSessionId: 'codex_parent',
        },
      }),
    ).toBe(true);
  });

  it('preserves legacy affinity.backendMode ACP compatibility for codex', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'codex',
        metadata: {
          affinity: {
            backendMode: 'acp',
          },
          codexSessionId: 'codex_parent',
        },
      }),
    ).toBe(true);
  });

  it('preserves nested externalSessionV1.codexBackendMode ACP compatibility for codex', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'codex',
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine_source',
            remoteSessionId: 'codex_parent',
            source: { kind: 'codexHome', home: 'user' },
            codexBackendMode: 'acp',
          },
          codexSessionId: 'codex_parent',
        },
      }),
    ).toBe(true);
  });

  it('prefers canonical runtimeDescriptorV1 over stale legacy ACP breadcrumbs when evaluating codex eligibility', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'codex',
        metadata: {
          acpHistoryImportV1: { v: 1, provider: 'codex' },
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: { backendMode: 'appServer', providerSessionId: 'codex_parent' },
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: { backendMode: 'acp', providerSessionId: 'codex_parent_legacy' },
          },
          codexSessionId: 'codex_parent',
        },
      }),
    ).toBe(false);
  });

  it('treats generic acpTransportV1 metadata as ACP eligibility for the matching provider', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          acpTransportV1: { v: 1, provider: 'opencode' },
          opencodeBackendMode: 'server',
        },
      }),
    ).toBe(true);
  });

  it('falls back to legacy ACP breadcrumbs when runtime metadata omits backendMode', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          acpTransportV1: { v: 1, provider: 'opencode' },
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            provider: { providerSessionId: 'opencode_parent' },
          },
          opencodeBackendMode: 'server',
        },
      }),
    ).toBe(true);
  });

  it('does not treat acpTransportV1 from a different provider as eligible', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          acpTransportV1: { v: 1, provider: 'codex' },
        },
      }),
    ).toBe(false);
  });

  it('treats legacy opencodeBackendMode=acp metadata as ACP eligibility for opencode', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          opencodeBackendMode: 'acp',
        },
      }),
    ).toBe(true);
  });

  it('treats provider-keyed legacy runtime descriptors as ACP eligibility for the matching provider', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          opencodeRuntimeDescriptorV1: {
            v: 1,
            backendMode: 'acp',
          },
        },
      }),
    ).toBe(true);
  });

  it('treats agent-keyed linked external-session metadata as ACP eligibility for the matching agent', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_parent',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
            opencodeBackendMode: 'acp',
          },
        },
      }),
    ).toBe(true);
  });

  it('does not apply linked-session backend mode from a different canonical agent', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine_source',
            remoteSessionId: 'codex_parent',
            source: { kind: 'codexHome', home: 'user' },
            opencodeBackendMode: 'acp',
          },
        },
      }),
    ).toBe(false);
  });

  it('recognizes retained legacy directSessionV1 backend mode through the canonical link reader', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          directSessionV1: {
            v: 1,
            providerId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_parent',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
            opencodeBackendMode: 'acp',
          },
        },
      }),
    ).toBe(true);
  });

  it('does not treat provider-specific legacy mode aliases as generic ACP eligibility', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          opencodeRuntimeDescriptorV1: {
            v: 1,
            backendMode: 'mcp_resume',
          },
        },
      }),
    ).toBe(false);
  });
});
