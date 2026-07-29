import { describe, expect, it } from 'vitest';

import { buildOpenCodeRuntimeIdentityDescriptorV1 } from '@happier-dev/plugins-opencode/agent/identity/runtimeDescriptor';
import { resolveSessionHandoffEligibility } from './resolveSessionHandoffEligibility';

describe('resolveSessionHandoffEligibility', () => {
  it('allows an eligible persisted Claude session', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: {
          flavor: 'claude',
          machineId: 'machine_source',
          claudeSessionId: 'sess_1',
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'claude',
      storageMode: 'persisted',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'sess_1',
    });
  });

  it('allows an eligible direct OpenCode session', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: {
          flavor: 'opencode',
          machineId: 'machine_source',
          opencodeSessionId: 'sess_2',
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'sess_2',
            source: { kind: 'opencodeServer', directory: '/repo' },
            linkedAtMs: 1,
          },
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'opencode',
      storageMode: 'direct',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'sess_2',
    });
  });

  it('resolves provider identity from runtime descriptor metadata when flavor is unavailable', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: {
          machineId: 'machine_source',
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_runtime_1',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
            linkedAtMs: 1,
            agentRuntimeDescriptorV1: buildOpenCodeRuntimeIdentityDescriptorV1({
              backendMode: 'server',
              providerSessionId: 'opencode_runtime_1',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
            }),
          },
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'opencode',
      storageMode: 'direct',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'opencode_runtime_1',
    });
  });

  it('resolves agent identity from canonical external-session links when flavor is unavailable', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: {
          machineId: 'machine_source',
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_runtime_2',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
            linkedAtMs: 1,
          },
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'opencode',
      storageMode: 'direct',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'opencode_runtime_2',
    });
  });

  it('recognizes an A13-retained legacy directSessionV1 link as direct storage', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: {
          machineId: 'machine_source',
          directSessionV1: {
            v: 1,
            providerId: 'opencode',
            machineId: 'machine_source',
            remoteSessionId: 'opencode_legacy',
            source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
            linkedAtMs: 1,
          },
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'opencode',
      storageMode: 'direct',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'opencode_legacy',
    });
  });

  it('rejects sessions whose provider cannot be inferred', () => {
    expect(resolveSessionHandoffEligibility({ metadata: { machineId: 'm1' } })).toEqual({
      eligible: false,
      reasonCode: 'agent_unknown',
    });
  });

  it('rejects sessions missing a source machine id', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: { flavor: 'claude', claudeSessionId: 'sess_1' },
      }),
    ).toEqual({
      eligible: false,
      reasonCode: 'source_machine_missing',
    });
  });

  it('does not classify malformed external-session metadata as direct storage', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: {
          flavor: 'pi',
          machineId: 'machine_source',
          piSessionId: 'sess_pi',
          externalSessionV1: {
            v: 1,
            agentId: 'pi',
          },
        },
      }),
    ).toEqual({
      eligible: false,
      reasonCode: 'handoff_unsupported',
      agentId: 'pi',
      storageMode: 'persisted',
    });
  });

  it('allows a codex app-server session without requiring account settings', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: {
          flavor: 'codex',
          machineId: 'machine_source',
          codexSessionId: 'codex_1',
          codexBackendMode: 'appServer',
        },
      }),
    ).toEqual({
      eligible: true,
      agentId: 'codex',
      storageMode: 'persisted',
      sourceMachineId: 'machine_source',
      vendorHandoffId: 'codex_1',
    });
  });
});
