import { describe, expect, it } from 'vitest';

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
          directSessionV1: {
            v: 1,
            providerId: 'opencode',
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

  it('rejects unsupported direct session storage providers', () => {
    expect(
      resolveSessionHandoffEligibility({
        metadata: {
          flavor: 'pi',
          machineId: 'machine_source',
          piSessionId: 'sess_pi',
          directSessionV1: {
            v: 1,
            providerId: 'claude',
          },
        },
      }),
    ).toEqual({
      eligible: false,
      reasonCode: 'storage_mode_unsupported',
      agentId: 'pi',
      storageMode: 'direct',
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
