import { describe, expect, it } from 'vitest';

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

  it('keeps Codex on the hot-apply path when the runtime callback is temporarily unavailable', async () => {
    await expect(resolveCodexConnectedServiceSwitchContinuity(createParams({
      connectedServiceMaterializationIdentityV1: null,
      vendorResumeId: null,
      targetMaterializedRoot: null,
      targetMaterializedEnv: null,
      cwd: null,
      runtimeAuthSelection: {
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
});
