import { describe, expect, it, vi } from 'vitest';

import { resolvePiConnectedServiceSwitchContinuity } from './switchContinuity.js';

type Binding = Readonly<{
  source: 'native' | 'connected';
  selection: 'native' | 'profile' | 'group';
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
}>;

function paramsWithBindings(previousBinding: Binding | null, nextBinding: Binding) {
  return {
    sessionId: 'sess_1',
    agentId: 'pi',
    serviceId: 'anthropic',
    previousBinding,
    nextBinding,
    fromBindings: { v: 1, bindingsByServiceId: {} },
    toBindings: { v: 1, bindingsByServiceId: {} },
  };
}

describe('resolvePiConnectedServiceSwitchContinuity', () => {
  it('requires shared state continuity for different connected selections', async () => {
    const previousBinding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: null,
    };
    const nextBinding = {
      ...previousBinding,
      profileId: 'backup',
    };

    await expect(resolvePiConnectedServiceSwitchContinuity({
      runtimeControl: { reachability: { verifyMaterializedState: vi.fn() } } as never,
      params: paramsWithBindings(previousBinding, nextBinding),
    })).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'pi_exact_connected_service_selection_required',
    });
  });

  it('certifies same-home continuity through the host reachability service', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'group' as const,
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: 'work',
    };
    const verifyMaterializedState = vi.fn(async () => ({
      ok: true,
      value: { ok: true },
    }));

    await expect(resolvePiConnectedServiceSwitchContinuity({
      runtimeControl: { reachability: { verifyMaterializedState } } as never,
      params: {
        ...paramsWithBindings(binding, binding),
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'mat_pi_group',
          createdAt: 1,
        },
        vendorResumeId: 'pi-session-1',
        targetMaterializedRoot: '/tmp/materialized',
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/materialized/pi-agent-dir' },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: '/tmp/pi-session.jsonl',
      },
    })).resolves.toEqual({ mode: 'restart_same_home' });
  });

  it('returns daemon-safe diagnostics when exact continuity cannot find the PI session file', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'group' as const,
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: 'work',
    };
    const diagnostics = {
      materializationIdentityId: 'mat_pi_group',
      targetMaterializedRoot: '/tmp/materialized',
      vendorResumeId: 'pi-session-missing',
      cwd: '/tmp/project',
      candidatePersistedSessionFile: '/tmp/pi-session.jsonl',
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      reachabilityMissReason: 'pi_session_file_not_found',
    };
    const verifyMaterializedState = vi.fn(async () => ({
      ok: true,
      value: { ok: false, continuityDiagnostics: diagnostics },
    }));

    await expect(resolvePiConnectedServiceSwitchContinuity({
      runtimeControl: { reachability: { verifyMaterializedState } } as never,
      params: {
        ...paramsWithBindings(binding, { ...binding, profileId: 'backup' }),
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'mat_pi_group',
          createdAt: 1,
        },
        vendorResumeId: 'pi-session-missing',
        targetMaterializedRoot: '/tmp/materialized',
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/materialized/pi-agent-dir' },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: '/tmp/pi-session.jsonl',
      },
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
      diagnostics,
    });
  });
});
