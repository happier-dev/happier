import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { getConnectedServiceRuntimeAuthAdapter } from '../../catalogHooks';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../../connectedServiceChildEnvironment';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '../../runtimeAuth/types';
import { resolveSharedGenerationApplicationProof } from './resolveSharedGenerationApplicationProof';
import { logger } from '@/ui/logger';

const targetMaterializedEnv = {
  CLAUDE_CONFIG_DIR: '/tmp/claude-coders',
  [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: '/tmp/claude-coders',
};

async function runtimeAuthAdapterWithVerification(
  verifyActiveAccount: NonNullable<ConnectedServiceProviderRuntimeAuthAdapter['verifyActiveAccount']>,
): Promise<ConnectedServiceProviderRuntimeAuthAdapter> {
  const adapter = await getConnectedServiceRuntimeAuthAdapter('claude');
  if (!adapter) throw new Error('Claude runtime auth adapter was not admitted');
  // Provider-native account verification is the external boundary under test.
  return { ...adapter, verifyActiveAccount };
}

const record: ConnectedServiceCredentialRecordV1 = {
  v: 1,
  serviceId: 'claude-subscription',
  profileId: 'team',
  kind: 'oauth',
  createdAt: 1,
  updatedAt: 1,
  expiresAt: null,
  oauth: {
    accessToken: 'access-placeholder',
    refreshToken: 'refresh-placeholder',
    idToken: null,
    scope: null,
    tokenType: 'Bearer',
    providerAccountId: 'team-account',
    providerEmail: 'team@example.com',
    raw: null,
  },
  token: null,
};

function committedGeneration(credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa') {
  return buildConnectedServiceAuthGroupCommittedGenerationFact({
    decisionId: 'decision-1',
    provenance: 'reconciliation',
    requestedTarget: { profileId: 'team' },
    decisionCommittedTarget: {
      serviceId: 'happier.agent.claude/claude-subscription',
      groupId: 'coders',
      profileId: 'team',
      generation: 12,
      credentialRevision,
    },
  });
}

describe('resolveSharedGenerationApplicationProof', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;

  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.claude'] },
    });
  });

  afterAll(async () => {
    await runtime?.dispose();
    await pluginReloadController.shutdown();
  });

  it('relays provider-owned exact generation provenance without strengthening desired bytes', async () => {
    const verifyActiveAccount = vi.fn<
      NonNullable<ConnectedServiceProviderRuntimeAuthAdapter['verifyActiveAccount']>
    >(async () => ({
      status: 'verified' as const,
      providerAccountId: 'team-account',
      activeAccountId: 'team@example.com',
      sharedAuthSurfaceId: 'coders',
      proofStrength: 'exact' as const,
      source: 'shared_group_auth_surface',
      reason: 'claude_shared_group_auth_surface_rewritten',
      generationApplication: {
        serviceId: 'happier.agent.claude/claude-subscription' as const,
        groupId: 'coders',
        profileId: 'team',
        generation: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        credentialFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    }));

    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv,
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => ({
        record,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }),
      resolveRuntimeAuthAdapter: async () => runtimeAuthAdapterWithVerification(verifyActiveAccount),
    })).resolves.toEqual({
      serviceId: 'happier.agent.claude/claude-subscription',
      groupId: 'coders',
      profileId: 'team',
      generation: 12,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      proof: {
        status: 'verified',
        source: 'shared_group_auth_surface',
        providerAccountId: 'team-account',
        activeAccountId: 'team@example.com',
        sharedAuthSurfaceId: 'coders',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        credentialFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    expect(verifyActiveAccount).toHaveBeenCalledWith({
      target: { agentId: 'claude' },
      selection: {
        serviceId: 'happier.agent.claude/claude-subscription',
        groupId: 'coders',
        activeProfileId: 'team',
        profileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
      credential: record,
      nativeHome: {
        readFiles: expect.any(Function),
        replaceFiles: expect.any(Function),
      },
    });
    expect(verifyActiveAccount.mock.calls[0]?.[0]).not.toHaveProperty('nativeHome.root');
  });

  it('does not upgrade weak byte equality to the requested generation epoch', async () => {
    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv,
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => ({ record, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' }),
      resolveRuntimeAuthAdapter: async () => runtimeAuthAdapterWithVerification(async () => ({
        status: 'weakly_verified',
        sharedAuthSurfaceId: 'coders',
        proofStrength: 'weak',
        source: 'shared_group_auth_surface',
        reason: 'bytes_match_without_epoch_provenance',
      })),
    })).resolves.toBeNull();
  });

  it('verifies the current selected account revision after credentials refresh past the commit', async () => {
    const verifyActiveAccount: NonNullable<ConnectedServiceProviderRuntimeAuthAdapter['verifyActiveAccount']> = async () => ({
      status: 'verified', proofStrength: 'exact', providerAccountId: 'team-account',
      source: 'shared_group_auth_surface', sharedAuthSurfaceId: 'coders',
      generationApplication: { serviceId: 'happier.agent.claude/claude-subscription', groupId: 'coders',
        profileId: 'team', generation: 12, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        credentialFingerprint: 'sha256:current-account' },
    });
    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv,
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => ({
        record,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      }),
      resolveRuntimeAuthAdapter: async () => runtimeAuthAdapterWithVerification(verifyActiveAccount),
    })).resolves.toMatchObject({ credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      proof: { credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb', providerAccountId: 'team-account' } });
  });

  it('does not upgrade a weak proof from a different source or auth surface', async () => {
    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv,
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => ({
        record,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }),
      resolveRuntimeAuthAdapter: async () => runtimeAuthAdapterWithVerification(async () => ({
        status: 'weakly_verified',
        sharedAuthSurfaceId: 'other-group',
        proofStrength: 'weak',
        source: 'account_identity',
        reason: 'unrelated',
      })),
    })).resolves.toBeNull();
  });

  it('treats unavailable canonical or provider verification as no replay proof so a normal apply can proceed', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv,
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => {
        throw new Error('credential API unavailable');
      },
      resolveRuntimeAuthAdapter: async () => {
        throw new Error('adapter unavailable');
      },
    })).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith('[Connected Services] credential_revision_read_failed');
    } finally { warn.mockRestore(); }
  });
});
