import { describe, expect, it } from 'vitest';

import {
  type AcceptedConnectedServiceAccountVerification,
  hasExactAcceptedConnectedServiceTargetAdoptionProof,
  isExactAcceptedConnectedServiceAccountVerification,
  toAcceptedConnectedServiceAccountVerification,
} from './acceptedConnectedServiceAccountVerification';

describe('accepted connected-service account verification', () => {
  it('preserves exact shared-auth-surface identity material', () => {
    const verification = toAcceptedConnectedServiceAccountVerification({
      status: 'verified',
      sharedAuthSurfaceId: 'claude-team',
      proofStrength: 'exact',
      source: 'runtime_identity_probe',
    } satisfies AcceptedConnectedServiceAccountVerification);

    expect(verification).toEqual({
      status: 'verified',
      sharedAuthSurfaceId: 'claude-team',
      proofStrength: 'exact',
      source: 'runtime_identity_probe',
    });
    expect(isExactAcceptedConnectedServiceAccountVerification(verification)).toBe(true);
  });

  it('accepts exact identity proof for the selected account across credential refreshes', () => {
    const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const verificationByServiceId = {
      'openai-codex': {
        status: 'verified',
        providerAccountId: 'provider-account-b',
        proofStrength: 'exact',
        generationApplication: {
          serviceId: 'openai-codex',
          groupId: 'group-a',
          profileId: 'profile-b',
          generation: 2,
          credentialRevision,
          credentialFingerprint: 'fingerprint-b',
        },
      },
    } satisfies Readonly<Record<string, AcceptedConnectedServiceAccountVerification>>;

    expect(hasExactAcceptedConnectedServiceTargetAdoptionProof({
      verificationByServiceId,
      target: {
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-b',
        generation: 2,
        credentialRevision,
      },
    })).toBe(true);

    expect(hasExactAcceptedConnectedServiceTargetAdoptionProof({
      verificationByServiceId,
      target: {
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-b',
        generation: 2,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      },
    })).toBe(true);
    expect(hasExactAcceptedConnectedServiceTargetAdoptionProof({
      verificationByServiceId,
      target: {
        serviceId: 'openai-codex', groupId: 'group-a', profileId: 'other-account', generation: 2, credentialRevision,
      },
    })).toBe(false);
  });

  it.each([
    ['weak proof', {
      status: 'weakly_verified',
      providerAccountId: 'provider-account-b',
      proofStrength: 'weak',
    }],
    ['exact proof without identity material', {
      status: 'verified',
      proofStrength: 'exact',
      generationApplication: {
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-b',
        generation: 2,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        credentialFingerprint: 'fingerprint-b',
      },
    }],
    ['exact proof without generation application', {
      status: 'verified',
      providerAccountId: 'provider-account-b',
      proofStrength: 'exact',
    }],
  ] as const)('rejects %s as exact target adoption', (_label, verification) => {
    expect(hasExactAcceptedConnectedServiceTargetAdoptionProof({
      verificationByServiceId: { 'openai-codex': verification },
      target: {
        serviceId: 'openai-codex',
        groupId: 'group-a',
        profileId: 'profile-b',
        generation: 2,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    })).toBe(false);
  });
});
