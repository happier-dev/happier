import { describe, expect, it } from 'vitest';

import { resolveCommittedGenerationFromRuntimeAuthRecovery } from './resolveCommittedGenerationFromRuntimeAuthRecovery';

describe('resolveCommittedGenerationFromRuntimeAuthRecovery', () => {
  const credentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';

  it.each([
    ['switched', true],
    ['observed_generation', true],
    ['superseded_after_apply', true],
  ] as const)('resolves the authoritative %s target', (status, sourceRequiresConvergence) => {
    const resolved = resolveCommittedGenerationFromRuntimeAuthRecovery({
      serviceId: 'openai-codex',
      groupId: 'group-a',
      recovery: {
        status: 'switch_attempted',
        result: {
          status,
          activeProfileId: status === 'superseded_after_apply' ? 'profile-c' : 'profile-b',
          generation: status === 'superseded_after_apply' ? 3 : 2,
          credentialRevision,
        },
      },
    });

    expect(resolved).toEqual({
      committedGeneration: expect.objectContaining({
        provenance: 'hard_limit',
        decisionCommittedTarget: {
          serviceId: 'openai-codex',
          groupId: 'group-a',
          profileId: status === 'superseded_after_apply' ? 'profile-c' : 'profile-b',
          generation: status === 'superseded_after_apply' ? 3 : 2,
          credentialRevision,
        },
      }),
      sourceRequiresConvergence,
    });
  });

  it.each(['switched', 'observed_generation'] as const)(
    'excludes the source only with exact matching target-adoption proof for %s',
    (status) => {
      const resolved = resolveCommittedGenerationFromRuntimeAuthRecovery({
        serviceId: 'openai-codex',
        groupId: 'group-a',
        recovery: {
          status: 'switch_attempted',
          result: {
            status,
            activeProfileId: 'profile-b',
            generation: 2,
            credentialRevision,
            verificationByServiceId: {
              'openai-codex': {
                status: 'verified',
                proofStrength: 'exact',
                providerAccountId: 'provider-account-b',
                credentialRevision,
                generationApplication: {
                  serviceId: 'openai-codex',
                  groupId: 'group-a',
                  profileId: 'profile-b',
                  generation: 2,
                  credentialRevision,
                  credentialFingerprint: 'fingerprint-b',
                },
              },
            },
          },
        },
      });

      expect(resolved?.sourceRequiresConvergence).toBe(false);
    },
  );

  it.each([
    ['weak proof', { status: 'weakly_verified', proofStrength: 'weak', providerAccountId: 'provider-account-b' }],
    ['mismatched target', {
      status: 'verified', proofStrength: 'exact', providerAccountId: 'provider-account-b',
      generationApplication: { serviceId: 'openai-codex', groupId: 'group-a', profileId: 'profile-other', generation: 2, credentialRevision, credentialFingerprint: 'other' },
    }],
  ] as const)('keeps the source when adoption has %s', (_label, verification) => {
    expect(resolveCommittedGenerationFromRuntimeAuthRecovery({
      serviceId: 'openai-codex',
      groupId: 'group-a',
      recovery: { status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'profile-b', generation: 2, credentialRevision, verificationByServiceId: { 'openai-codex': verification } } },
    })?.sourceRequiresConvergence).toBe(true);
  });

  it('keeps an omitted predecessor revision unknown', () => {
    const resolved = resolveCommittedGenerationFromRuntimeAuthRecovery({
      serviceId: 'openai-codex',
      groupId: 'group-a',
      recovery: {
        status: 'switch_attempted',
        result: {
          status: 'switched',
          activeProfileId: 'profile-b',
          generation: 2,
        },
      },
    });

    expect(resolved?.committedGeneration.decisionCommittedTarget.credentialRevision).toBeNull();
  });

  it('uses the exact credential revision in the decision identity', () => {
    const resolveRevision = (revision: string) => resolveCommittedGenerationFromRuntimeAuthRecovery({
      serviceId: 'openai-codex',
      groupId: 'group-a',
      recovery: {
        status: 'switch_attempted',
        result: {
          status: 'switched',
          activeProfileId: 'profile-b',
          generation: 2,
          credentialRevision: revision,
        },
      },
    })?.committedGeneration.decisionId;

    expect(resolveRevision('csr_aaaaaaaaaaaaaaaaaaaaaa')).not.toBe(
      resolveRevision('csr_bbbbbbbbbbbbbbbbbbbbbb'),
    );
  });

  it.each([
    null,
    { status: 'failed' },
    { status: 'switch_attempted', result: { status: 'no_eligible_profile' } },
    { status: 'switch_attempted', result: { status: 'switched', activeProfileId: '', generation: 2 } },
    { status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'profile-b', generation: -1 } },
    { status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'profile-b', generation: 2, credentialRevision: 'invalid' } },
  ])('fails closed without an authoritative target', (recovery) => {
    expect(resolveCommittedGenerationFromRuntimeAuthRecovery({
      serviceId: 'openai-codex',
      groupId: 'group-a',
      recovery,
    })).toBeNull();
  });
});
