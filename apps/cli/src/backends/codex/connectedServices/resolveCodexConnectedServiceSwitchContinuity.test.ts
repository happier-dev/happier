import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import type { ConnectedServiceSwitchContinuityParams } from '@/backends/types';

import { resolveCodexConnectedServiceSwitchContinuity } from './resolveCodexConnectedServiceSwitchContinuity';

function createParams(
  overrides: Partial<ConnectedServiceSwitchContinuityParams> = {},
): ConnectedServiceSwitchContinuityParams {
  return {
    sessionId: 'session-1',
    agentId: 'codex',
    serviceId: 'openai-codex',
    previousBinding: {
      source: 'connected',
      selection: 'group',
      serviceId: 'openai-codex',
      profileId: 'old',
      groupId: 'team',
    },
    nextBinding: {
      source: 'connected',
      selection: 'group',
      serviceId: 'openai-codex',
      profileId: 'new',
      groupId: 'team',
    },
    fromBindings: {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'group', groupId: 'team', profileId: 'old' },
      },
    },
    toBindings: {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'group', groupId: 'team', profileId: 'new' },
      },
    },
    connectedServiceMaterializationIdentityV1: {
      v: 1,
      id: 'materialization-1',
      createdAtMs: 1,
    },
    vendorResumeId: 'vendor-session-1',
    targetMaterializedRoot: '/tmp/codex-materialized',
    targetMaterializedEnv: {
      CODEX_HOME: '/tmp/codex-materialized/codex-home',
      CODEX_SQLITE_HOME: '/tmp/codex-materialized/codex-home',
    },
    cwd: '/tmp/project',
    ...overrides,
  };
}

describe('resolveCodexConnectedServiceSwitchContinuity', () => {
  it('uses direct live apply when an active native Codex session switches into connected auth', async () => {
    await expect(resolveCodexConnectedServiceSwitchContinuity(createParams({
      previousBinding: {
        source: 'native',
        selection: 'native',
        serviceId: 'openai-codex',
        profileId: null,
        groupId: null,
      },
      fromBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'native' },
        },
      },
      runtimeAuthSelection: {
        applyConnectedServiceAuthGeneration: async () => ({ ok: true }),
        record: buildConnectedServiceCredentialRecord({
          now: 1_000,
          serviceId: 'openai-codex',
          profileId: 'new',
          kind: 'oauth',
          expiresAt: 2_000,
          oauth: {
            accessToken: 'access',
            refreshToken: 'refresh',
            idToken: 'id',
            scope: null,
            tokenType: null,
            providerAccountId: 'acct',
            providerEmail: 'codex-user@example.test',
          },
        }),
      },
    }))).resolves.toEqual({ mode: 'hot_apply' });
  });

  it('keeps direct-live-required runtime auth selections on the hot-apply path when the runtime callback is unavailable', async () => {
    await expect(resolveCodexConnectedServiceSwitchContinuity(createParams({
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      targetMaterializedRoot: null,
      targetMaterializedEnv: null,
      cwd: null,
      runtimeAuthSelection: {
        requireDirectLiveHotApply: true,
        record: buildConnectedServiceCredentialRecord({
          now: 1_000,
          serviceId: 'openai-codex',
          profileId: 'new',
          kind: 'oauth',
          expiresAt: 2_000,
          oauth: {
            accessToken: 'access',
            refreshToken: 'refresh',
            idToken: 'id',
            scope: null,
            tokenType: null,
            providerAccountId: 'acct',
            providerEmail: 'codex-user@example.test',
          },
        }),
      },
    }))).resolves.toEqual({
      mode: 'hot_apply',
    });
  });

  it('fails closed for same-group switches when exact resume reachability inputs are missing', async () => {
    await expect(resolveCodexConnectedServiceSwitchContinuity(createParams({
      targetMaterializedRoot: null,
    }))).resolves.toEqual({
      mode: 'unsupported',
      reason: 'provider_session_state_unavailable_for_resume',
    });
  });

  it('returns restart_same_home for same-group switches when codex session reachability is proven', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-switch-continuity-'));
    try {
      const sessionsDir = join(root, 'codex-home', 'sessions', 'workspace');
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, 'rollout-2026-05-27-vendor-session-1.jsonl'),
        '{}\n',
      );

      await expect(resolveCodexConnectedServiceSwitchContinuity(createParams({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          CODEX_HOME: join(root, 'codex-home'),
          CODEX_SQLITE_HOME: join(root, 'codex-home'),
        },
      }))).resolves.toEqual({
        mode: 'restart_same_home',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses a provider-owned persisted rollout candidate when the target materialized home is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-switch-continuity-empty-target-'));
    const nativeHome = await mkdtemp(join(tmpdir(), 'happier-codex-switch-continuity-native-'));
    try {
      const candidatePath = join(
        nativeHome,
        'sessions',
        '2026',
        '05',
        '31',
        'rollout-2026-05-31T09-35-00-vendor-session-1.jsonl',
      );
      await mkdir(join(nativeHome, 'sessions', '2026', '05', '31'), { recursive: true });
      await writeFile(candidatePath, '{}\n');

      await expect(resolveCodexConnectedServiceSwitchContinuity(createParams({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          CODEX_HOME: join(root, 'codex-home'),
          CODEX_SQLITE_HOME: join(root, 'codex-home'),
        },
        candidatePersistedSessionFile: candidatePath,
      }))).resolves.toEqual({
        mode: 'restart_same_home',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(nativeHome, { recursive: true, force: true });
    }
  });

  it('fails closed when the target materialized home is empty and no persisted rollout candidate exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-switch-continuity-empty-target-missing-'));
    try {
      await expect(resolveCodexConnectedServiceSwitchContinuity(createParams({
        targetMaterializedRoot: root,
        targetMaterializedEnv: {
          CODEX_HOME: join(root, 'codex-home'),
          CODEX_SQLITE_HOME: join(root, 'codex-home'),
        },
      }))).resolves.toMatchObject({
        mode: 'unsupported',
        reason: 'provider_session_state_unavailable_for_resume',
        diagnostics: {
          targetMaterializedRoot: root,
          vendorResumeId: 'vendor-session-1',
          candidatePersistedSessionFile: null,
          requestedStateMode: 'isolated',
          effectiveStateMode: 'isolated',
          reachabilityMissReason: 'codex_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
