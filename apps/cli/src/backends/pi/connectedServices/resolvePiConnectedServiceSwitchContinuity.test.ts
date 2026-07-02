import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConnectedServiceBindingSelectionV1 } from '@happier-dev/protocol';

import type { ConnectedServiceSwitchContinuityParams } from '@/backends/types';

import { resolvePiConnectedServiceSwitchContinuity } from './resolvePiConnectedServiceSwitchContinuity';

function toStoredBinding(
  binding: ConnectedServiceSwitchContinuityParams['nextBinding'],
): ConnectedServiceBindingSelectionV1 {
  if (binding.source === 'native') return { source: 'native' };
  if (binding.selection === 'profile') {
    if (!binding.profileId) throw new Error('profile fixture requires a profile id');
    return {
      source: 'connected',
      selection: 'profile',
      profileId: binding.profileId,
    };
  }
  if (!binding.groupId) throw new Error('group fixture requires a group id');
  return {
    source: 'connected',
    selection: 'group',
    groupId: binding.groupId,
    ...(binding.profileId ? { profileId: binding.profileId } : {}),
  };
}

function paramsWithBindings(
  previousBinding: ConnectedServiceSwitchContinuityParams['previousBinding'],
  nextBinding: ConnectedServiceSwitchContinuityParams['nextBinding'],
): ConnectedServiceSwitchContinuityParams {
  return {
    sessionId: 'sess_1',
    agentId: 'pi',
    serviceId: 'anthropic',
    previousBinding,
    nextBinding,
    fromBindings: {
      v: 1,
      bindingsByServiceId: {
        anthropic: previousBinding ? toStoredBinding(previousBinding) : { source: 'native' },
      },
    },
    toBindings: { v: 1, bindingsByServiceId: { anthropic: toStoredBinding(nextBinding) } },
  };
}

describe('resolvePiConnectedServiceSwitchContinuity', () => {
  it.each([
    {
      name: 'different connected profiles',
      previousBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        serviceId: 'anthropic' as const,
        profileId: 'primary',
        groupId: null,
      },
      nextBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        serviceId: 'anthropic' as const,
        profileId: 'backup',
        groupId: null,
      },
    },
    {
      name: 'profile to group',
      previousBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        serviceId: 'anthropic' as const,
        profileId: 'primary',
        groupId: null,
      },
      nextBinding: {
        source: 'connected' as const,
        selection: 'group' as const,
        serviceId: 'anthropic' as const,
        profileId: 'primary',
        groupId: 'work',
      },
    },
    {
      name: 'group to profile',
      previousBinding: {
        source: 'connected' as const,
        selection: 'group' as const,
        serviceId: 'anthropic' as const,
        profileId: 'primary',
        groupId: 'work',
      },
      nextBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        serviceId: 'anthropic' as const,
        profileId: 'primary',
        groupId: null,
      },
    },
  ])('requires shared state continuity for $name', async ({ previousBinding, nextBinding }) => {
    await expect(resolvePiConnectedServiceSwitchContinuity(
      paramsWithBindings(previousBinding, nextBinding),
    )).resolves.toEqual({
      mode: 'restart_shared_state_required',
      reason: 'pi_exact_connected_service_selection_required',
    });
  });

  it('requires provider resume context for same-home continuity with the exact same profile selection', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: null,
    };

    await expect(resolvePiConnectedServiceSwitchContinuity(
      paramsWithBindings(binding, binding),
    )).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('fails closed for same-home continuity when exact profile context lacks materialized-state reachability context', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: null,
    };

    await expect(resolvePiConnectedServiceSwitchContinuity({
      ...paramsWithBindings(binding, binding),
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'mat_pi_primary',
        createdAt: 1,
      },
      vendorResumeId: 'vendor-session-1',
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('certifies same-home continuity when exact profile context includes reachable materialized state', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: null,
    };
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-continuity-'));
    const sessionPath = join(
      root,
      'pi-agent-dir',
      'sessions',
      '--tmp-project--',
      '2026-05-27T00-00-00-000Z_pi-session-1.jsonl',
    );

    try {
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(sessionPath, '{}\n');

      await expect(resolvePiConnectedServiceSwitchContinuity({
        ...paramsWithBindings(binding, binding),
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'mat_pi_primary',
          createdAt: 1,
        },
        vendorResumeId: 'pi-session-1',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: sessionPath,
      })).resolves.toEqual({ mode: 'restart_same_home' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires provider resume context for same-home continuity with the exact same group selection', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'group' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: 'work',
    };

    await expect(resolvePiConnectedServiceSwitchContinuity(
      paramsWithBindings(binding, binding),
    )).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('fails closed for same-home continuity when exact group context lacks materialized-state reachability context', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'group' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: 'work',
    };

    await expect(resolvePiConnectedServiceSwitchContinuity({
      ...paramsWithBindings(binding, binding),
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'mat_pi_group',
        createdAt: 1,
      },
      vendorResumeId: 'vendor-session-1',
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('treats same auth-group profile rotation as same-home continuity when provider resume context exists', async () => {
    const previousBinding = {
      source: 'connected' as const,
      selection: 'group' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: 'work',
    };
    const nextBinding = {
      ...previousBinding,
      profileId: 'backup',
    };

    await expect(resolvePiConnectedServiceSwitchContinuity(
      paramsWithBindings(previousBinding, nextBinding),
    )).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
    await expect(resolvePiConnectedServiceSwitchContinuity({
      ...paramsWithBindings(previousBinding, nextBinding),
      connectedServiceMaterializationIdentityV1: {
        v: 1,
        id: 'mat_pi_group',
        createdAt: 1,
      },
      vendorResumeId: 'vendor-session-1',
    })).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('returns daemon-safe diagnostics when exact continuity cannot find the PI session file', async () => {
    const previousBinding = {
      source: 'connected' as const,
      selection: 'group' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: 'work',
    };
    const nextBinding = {
      ...previousBinding,
      profileId: 'backup',
    };
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-continuity-missing-'));

    try {
      const candidate = join(root, 'native', 'missing-session.jsonl');

      await expect(resolvePiConnectedServiceSwitchContinuity({
        ...paramsWithBindings(previousBinding, nextBinding),
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'mat_pi_group',
          createdAt: 1,
        },
        vendorResumeId: 'pi-session-missing',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'pi-agent-dir'),
        },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
      })).resolves.toMatchObject({
        mode: 'unsupported',
        reason: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          materializationIdentityId: 'mat_pi_group',
          targetMaterializedRoot: root,
          vendorResumeId: 'pi-session-missing',
          cwd: '/tmp/project',
          candidatePersistedSessionFile: candidate,
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
