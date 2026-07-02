import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConnectedServiceBindingSelectionV1 } from '@happier-dev/protocol';

import type { ConnectedServiceSwitchContinuityParams } from '@/backends/types';

import { resolveOhMyPiConnectedServiceSwitchContinuity } from './resolveOhMyPiConnectedServiceSwitchContinuity';

function toStoredBinding(
  binding: ConnectedServiceSwitchContinuityParams['nextBinding'],
): ConnectedServiceBindingSelectionV1 {
  if (binding.source === 'native') return { source: 'native' };
  if (binding.selection === 'profile') {
    if (!binding.profileId) throw new Error('profile fixture requires profileId');
    return { source: 'connected', selection: 'profile', profileId: binding.profileId };
  }
  if (!binding.groupId) throw new Error('group fixture requires groupId');
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
    sessionId: 'sess_omp_1',
    agentId: 'ohMyPi',
    serviceId: 'anthropic',
    previousBinding,
    nextBinding,
    fromBindings: {
      v: 1,
      bindingsByServiceId: {
        anthropic: previousBinding ? toStoredBinding(previousBinding) : { source: 'native' },
      },
    },
    toBindings: {
      v: 1,
      bindingsByServiceId: {
        anthropic: toStoredBinding(nextBinding),
      },
    },
  };
}

describe('resolveOhMyPiConnectedServiceSwitchContinuity', () => {
  it('uses restart/rematerialize continuity when switching between distinct connected selections', async () => {
    const previousBinding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: null,
    };
    const nextBinding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'backup',
      groupId: null,
    };

    await expect(resolveOhMyPiConnectedServiceSwitchContinuity(
      paramsWithBindings(previousBinding, nextBinding),
    )).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'ohmypi_restart_rematerialize_required',
    });
  });

  it('uses restart/rematerialize continuity when switching from native auth to connected auth', async () => {
    const nextBinding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: null,
    };

    await expect(resolveOhMyPiConnectedServiceSwitchContinuity(
      paramsWithBindings({
        source: 'native',
        selection: 'native',
        serviceId: 'anthropic',
        profileId: null,
        groupId: null,
      }, nextBinding),
    )).resolves.toEqual({
      mode: 'restart_same_home',
      reason: 'ohmypi_restart_rematerialize_required',
    });
  });

  it('fails closed when exact connected selection lacks reachability context', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: null,
    };

    await expect(resolveOhMyPiConnectedServiceSwitchContinuity(
      paramsWithBindings(binding, binding),
    )).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('returns restart_same_home when exact selection has provably reachable session state', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: null,
    };
    const root = await mkdtemp(join(tmpdir(), 'happier-ohmypi-continuity-'));
    const agentDir = join(root, 'omp-agent-dir');
    const sessionPath = join(
      agentDir,
      'sessions',
      '--tmp-project--',
      '2026-05-28T00-00-00-000Z_omp-session-1.jsonl',
    );

    try {
      await mkdir(join(agentDir, 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(sessionPath, '{}\n');

      await expect(resolveOhMyPiConnectedServiceSwitchContinuity({
        ...paramsWithBindings(binding, binding),
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'mat_omp_1',
          createdAt: 1,
        },
        vendorResumeId: 'omp-session-1',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: agentDir,
        },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: sessionPath,
      })).resolves.toEqual({
        mode: 'restart_same_home',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns daemon-safe diagnostics when exact continuity cannot find the Oh My Pi session file', async () => {
    const binding = {
      source: 'connected' as const,
      selection: 'profile' as const,
      serviceId: 'anthropic' as const,
      profileId: 'primary',
      groupId: null,
    };
    const root = await mkdtemp(join(tmpdir(), 'happier-ohmypi-continuity-missing-'));

    try {
      const candidate = join(root, 'native', 'missing-session.jsonl');

      await expect(resolveOhMyPiConnectedServiceSwitchContinuity({
        ...paramsWithBindings(binding, binding),
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'mat_omp_1',
          createdAt: 1,
        },
        vendorResumeId: 'omp-session-missing',
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          PI_CODING_AGENT_DIR: join(root, 'omp-agent-dir'),
        },
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
      })).resolves.toMatchObject({
        mode: 'unsupported',
        reason: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          materializationIdentityId: 'mat_omp_1',
          targetMaterializedRoot: root,
          vendorResumeId: 'omp-session-missing',
          cwd: '/tmp/project',
          candidatePersistedSessionFile: candidate,
          reachabilityMissReason: 'ohmypi_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
