import { describe, expect, it, vi } from 'vitest';

import { resolveOhMyPiConnectedServiceSwitchContinuity } from './switchContinuity.js';

type Binding = Readonly<{
  source: 'native' | 'connected';
  selection: 'native' | 'profile' | 'group';
  serviceId: string;
  profileId: string | null;
  groupId: string | null;
}>;

function paramsWithBindings(previousBinding: Binding | null, nextBinding: Binding) {
  return {
    sessionId: 'sess_omp_1',
    agentId: 'ohMyPi',
    serviceId: 'anthropic',
    previousBinding,
    nextBinding,
    fromBindings: { v: 1, bindingsByServiceId: {} },
    toBindings: { v: 1, bindingsByServiceId: {} },
  };
}

describe('resolveOhMyPiConnectedServiceSwitchContinuity', () => {
  it('uses restart/rematerialize continuity when switching between distinct connected selections', async () => {
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

    await expect(resolveOhMyPiConnectedServiceSwitchContinuity({
      runtimeControl: { reachability: { verifyMaterializedState: vi.fn() } } as never,
      params: paramsWithBindings(previousBinding, nextBinding),
    })).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'ohmypi_restart_rematerialize_required',
    });
  });

  it('fails closed when exact connected selection lacks reachability context', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: null,
    };

    await expect(resolveOhMyPiConnectedServiceSwitchContinuity({
      runtimeControl: { reachability: { verifyMaterializedState: vi.fn() } } as never,
      params: paramsWithBindings(binding, binding),
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('returns daemon-safe diagnostics when exact continuity cannot find the OhMyPi session file', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic',
      profileId: 'primary',
      groupId: null,
    };
    const diagnostics = {
      materializationIdentityId: 'mat_omp_1',
      targetMaterializedRoot: '/tmp/materialized',
      vendorResumeId: 'omp-session-missing',
      cwd: '/tmp/project',
      candidatePersistedSessionFile: '/tmp/omp-session.jsonl',
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      reachabilityMissReason: 'ohmypi_session_file_not_found',
    };
    const verifyMaterializedState = vi.fn(async () => ({
      ok: true,
      value: { ok: false, continuityDiagnostics: diagnostics },
    }));

    await expect(resolveOhMyPiConnectedServiceSwitchContinuity({
      runtimeControl: { reachability: { verifyMaterializedState } } as never,
      params: {
        ...paramsWithBindings(binding, binding),
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'mat_omp_1',
          createdAt: 1,
        },
        vendorResumeId: 'omp-session-missing',
        targetMaterializedRoot: '/tmp/materialized',
        targetMaterializedEnv: { PI_CODING_AGENT_DIR: '/tmp/materialized/omp-agent-dir' },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: '/tmp/omp-session.jsonl',
      },
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
      diagnostics,
    });
  });
});
