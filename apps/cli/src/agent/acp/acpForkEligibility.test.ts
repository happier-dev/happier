import { describe, expect, it } from 'vitest';

import { isAcpForkEligibleForAgent } from './acpForkEligibility';

describe('isAcpForkEligibleForAgent', () => {
  it('uses the same published ACP fork strategy for an external Agent', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'externalAcp',
        metadata: {
          agentRuntimeCapabilitiesV1: {
            sessionCapabilities: {
              sessionFork: { protocol: 'acp' },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it('uses the same published ACP fork strategy for a bundled Agent', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'gemini',
        metadata: {
          agentRuntimeCapabilitiesV1: {
            sessionCapabilities: {
              sessionFork: { protocol: 'acp' },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it('rejects a published strategy when the current descriptor belongs to another Agent', () => {
    expect(isAcpForkEligibleForAgent({
      agentId: 'externalAcp',
      metadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'different-agent',
          agent: {},
        },
        agentRuntimeCapabilitiesV1: {
          sessionCapabilities: {
            sessionFork: { protocol: 'acp' },
          },
        },
      },
    })).toBe(false);
  });

  it('does not infer ACP fork from a bundled Agent id or tool-delivery convention', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'pi',
        metadata: {},
      }),
    ).toBe(false);
  });

  it('keeps the provider-owned current runtime descriptor opaque', () => {
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
    ).toBe(false);
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

  it('fails closed when a current runtimeDescriptorV1 is accompanied by stale legacy ACP breadcrumbs', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'codex',
        metadata: {
          acpHistoryImportV1: { v: 1, provider: 'codex' },
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: { backendMode: 'acp', providerSessionId: 'codex_parent' },
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

  it('does not let legacy breadcrumbs override a current opaque runtime descriptor', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'opencode',
        metadata: {
          acpTransportV1: { v: 1, provider: 'opencode' },
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            agent: { providerSessionId: 'opencode_parent' },
          },
          opencodeBackendMode: 'server',
        },
      }),
    ).toBe(false);
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

  it('treats the top-level agent-keyed backend mode as eligibility alongside a matching canonical link', () => {
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
          },
          opencodeBackendMode: 'acp',
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

  it('recognizes a retained legacy directSessionV1 Codex selector through the canonical link reader', () => {
    expect(
      isAcpForkEligibleForAgent({
        agentId: 'codex',
        metadata: {
          directSessionV1: {
            v: 1,
            providerId: 'codex',
            machineId: 'machine_source',
            remoteSessionId: 'codex_parent',
            source: { kind: 'codexHome', home: 'user' },
            codexBackendMode: 'acp',
          },
        },
      }),
    ).toBe(true);
  });

  it('keeps a linked-session runtime descriptor opaque without a released selector key', () => {
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
            runtimeDescriptorV1: {
              v: 1,
              agentId: 'codex',
              agent: { backendMode: 'acp' },
            },
          },
        },
      }),
    ).toBe(false);
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
