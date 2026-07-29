import { describe, expect, it, vi } from 'vitest';

import { applyConnectedServiceProjectionCredentialUpdate } from './applyConnectedServiceProjectionCredentialUpdate';

function target() {
  return {
    pid: 42,
    agentId: 'codex' as const,
    sessionId: 'session-42',
    materializationKey: 'materialization-42',
    bindings: [{
      serviceId: 'openai-codex' as const,
      profileId: 'work',
    }],
  };
}

describe('applyConnectedServiceProjectionCredentialUpdate', () => {
  it('settles authoritative deletion through the session lifecycle even when refresh is disabled', async () => {
    let targets = [target()];
    const stopSession = vi.fn(async () => {
      targets = [];
      return { status: 'stopped' as const };
    });

    await expect(applyConnectedServiceProjectionCredentialUpdate({
      input: {
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialPresence: { status: 'absent' },
        executionAuthority: 'passive_projection',
      },
      listRuntimeTargets: () => targets,
      stopSession,
      getRefreshCoordinator: () => null,
    })).resolves.toBeUndefined();

    expect(stopSession).toHaveBeenCalledWith('session-42');
  });

  it('does not acknowledge a present credential revision without its materialization owner', async () => {
    await expect(applyConnectedServiceProjectionCredentialUpdate({
      input: {
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialPresence: {
          status: 'present',
          credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        },
        executionAuthority: 'passive_projection',
      },
      listRuntimeTargets: () => [target()],
      stopSession: vi.fn(),
      getRefreshCoordinator: () => null,
    })).rejects.toThrow('connected_service_credential_projection_materialization_owner_unavailable');
  });

  it('delegates a present credential revision to the refresh materialization owner', async () => {
    const handleExternalCredentialUpdate = vi.fn(async () => {});
    const input = {
      serviceId: 'openai-codex' as const,
      profileId: 'work',
      credentialPresence: {
        status: 'present' as const,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
      executionAuthority: 'fresh_user_action' as const,
    };

    await applyConnectedServiceProjectionCredentialUpdate({
      input,
      listRuntimeTargets: () => [target()],
      stopSession: vi.fn(),
      getRefreshCoordinator: () => ({ handleExternalCredentialUpdate }),
    });

    expect(handleExternalCredentialUpdate).toHaveBeenCalledWith(input);
  });

  it('leaves a legacy-unfenced projection untouched', async () => {
    const stopSession = vi.fn();
    await expect(applyConnectedServiceProjectionCredentialUpdate({
      input: {
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialPresence: { status: 'legacy_unfenced' },
        executionAuthority: 'runtime_recovery',
      },
      listRuntimeTargets: () => [target()],
      stopSession,
      getRefreshCoordinator: () => null,
    })).resolves.toBeUndefined();
    expect(stopSession).not.toHaveBeenCalled();
  });
});
