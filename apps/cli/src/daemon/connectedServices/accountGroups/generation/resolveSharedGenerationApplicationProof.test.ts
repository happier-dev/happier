import { describe, expect, it, vi } from 'vitest';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { resolveSharedGenerationApplicationProof } from './resolveSharedGenerationApplicationProof';

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
      serviceId: 'claude-subscription',
      groupId: 'coders',
      profileId: 'team',
      generation: 12,
      credentialRevision,
    },
  });
}

describe('resolveSharedGenerationApplicationProof', () => {
  it('relays provider-owned exact generation provenance without strengthening desired bytes', async () => {
    const verifyActiveAccount = vi.fn(async () => ({
      status: 'verified' as const,
      providerAccountId: 'team-account',
      activeAccountId: 'team@example.com',
      sharedAuthSurfaceId: 'coders',
      proofStrength: 'exact' as const,
      source: 'shared_group_auth_surface',
      reason: 'claude_shared_group_auth_surface_rewritten',
      generationApplication: {
        serviceId: 'claude-subscription' as const,
        groupId: 'coders',
        profileId: 'team',
        generation: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        credentialFingerprint: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    }));

    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/claude-coders' },
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => ({
        record,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }),
      resolveRuntimeAuthAdapter: async () => ({ verifyActiveAccount } as never),
    })).resolves.toEqual({
      serviceId: 'claude-subscription',
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
        serviceId: 'claude-subscription',
        groupId: 'coders',
        activeProfileId: 'team',
        profileId: 'team',
        groupGeneration: 12,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        record,
      },
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/claude-coders' },
    });
  });

  it('does not upgrade weak byte equality to the requested generation epoch', async () => {
    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/claude-coders' },
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => ({ record, credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa' }),
      resolveRuntimeAuthAdapter: async () => ({
        verifyActiveAccount: async () => ({
          status: 'weakly_verified',
          sharedAuthSurfaceId: 'coders',
          proofStrength: 'weak',
          source: 'shared_group_auth_surface',
          reason: 'bytes_match_without_epoch_provenance',
        }),
      } as never),
    })).resolves.toBeNull();
  });

  it('fails closed before provider verification when the canonical credential revision differs', async () => {
    const verifyActiveAccount = vi.fn();
    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/claude-coders' },
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => ({
        record,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      }),
      resolveRuntimeAuthAdapter: async () => ({ verifyActiveAccount } as never),
    })).resolves.toBeNull();
    expect(verifyActiveAccount).not.toHaveBeenCalled();
  });

  it('does not upgrade a weak proof from a different source or auth surface', async () => {
    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/claude-coders' },
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => ({
        record,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      }),
      resolveRuntimeAuthAdapter: async () => ({
        verifyActiveAccount: async () => ({
          status: 'weakly_verified',
          sharedAuthSurfaceId: 'other-group',
          proofStrength: 'weak',
          source: 'account_identity',
          reason: 'unrelated',
        }),
      } as never),
    })).resolves.toBeNull();
  });

  it('treats unavailable canonical or provider verification as no replay proof so a normal apply can proceed', async () => {
    await expect(resolveSharedGenerationApplicationProof({
      agentId: 'claude',
      targetMaterializedEnv: { CLAUDE_CONFIG_DIR: '/tmp/claude-coders' },
      committedGeneration: committedGeneration(),
      resolveCredentialResolution: async () => {
        throw new Error('credential API unavailable');
      },
      resolveRuntimeAuthAdapter: async () => {
        throw new Error('adapter unavailable');
      },
    })).resolves.toBeNull();
  });
});
