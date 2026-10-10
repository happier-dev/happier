import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';
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

  it('distributes a novel qualified credential revision to each exact runtime target without a legacy service identity', async () => {
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    const serviceId = 'acme.plugin/novel-service';
    for (const [pid, profileId] of [[42, 'work'], [43, 'work'], [44, 'other']] as const) {
      runtimeRegistry.registerTarget({
        pid, agentId: 'codex', sessionId: `session-${pid}`, materializationKey: `materialization-${pid}`,
        connectedServicesBindingsRaw: { v: 2, bindingsByServiceId: {
          [serviceId]: { source: 'connected', selection: 'profile', profileId },
        } },
      });
    }
    type AuthUpdate = Parameters<NonNullable<ConstructorParameters<typeof ConnectedServiceRefreshCoordinator>[0]['onAuthUpdated']>>[0];
    const applications: AuthUpdate[] = [];
    const coordinator = new ConnectedServiceRefreshCoordinator({
      // API is a system boundary; this registry-only qualified dispatch must make no request.
      api: {} as ApiClient, credentials: { token: 'token', encryption: null },
      machineIdProvider: () => 'machine', activeServerDir: '/tmp/qualified-projection', baseDir: '/tmp/qualified-projection',
      refreshWindowMs: 60_000, refreshLeaseMs: 30_000, now: () => 1_000,
      runtimeRegistry, onAuthUpdated: (event) => { applications.push(event); },
    });
    const input = {
      serviceId, profileId: 'work',
      credentialPresence: { status: 'present', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' },
      executionAuthority: 'passive_projection',
    } as const;
    await applyConnectedServiceProjectionCredentialUpdate({
      input, listRuntimeTargets: () => runtimeRegistry.listRefreshTargets(),
      stopSession: async () => { throw new Error('Present credential must not stop the lifecycle'); },
      getRefreshCoordinator: () => coordinator,
    });
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      binding: { serviceId, profileId: 'work' }, credentialPresence: input.credentialPresence,
      executionAuthority: 'passive_projection',
    });
    expect(applications[0]?.affectedTargets.map((target) => target.sessionId).sort()).toEqual(['session-42', 'session-43']);
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
