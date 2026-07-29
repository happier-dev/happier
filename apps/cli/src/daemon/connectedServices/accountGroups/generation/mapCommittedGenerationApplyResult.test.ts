import { describe, expect, it } from 'vitest';

import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { mapCommittedGenerationApplyResult } from './mapCommittedGenerationApplyResult';

const committed = buildConnectedServiceAuthGroupCommittedGenerationFact({
  decisionId: 'decision-b',
  provenance: 'reconciliation',
  decisionCommittedTarget: {
    serviceId: 'openai-codex', groupId: 'team', profileId: 'profile-b', generation: 2,
    credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
  },
});

describe('mapCommittedGenerationApplyResult', () => {
  it.each(['switched', 'observed_generation'] as const)('maps %s to converged', (status) => {
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committed,
      result: {
        status,
        activeProfileId: 'profile-b',
        generation: 2,
        mode: 'hot_apply',
        providerApplication: 'applied',
        verificationByServiceId: {
          'openai-codex': {
            status: 'verified',
            proofStrength: 'exact',
            providerAccountId: 'acct-b',
            generationApplication: {
              serviceId: 'openai-codex',
              groupId: 'team',
              profileId: 'profile-b',
              generation: 2,
              credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
              credentialFingerprint: 'sha256:bbbbbbbb',
            },
          },
        },
      },
    })).toEqual({
      reconciliationDisposition: 'converged',
      errorCode: null,
      providerAdoptedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'profile-b',
        generation: 2,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
        proof: {
          status: 'verified',
          source: 'post_switch_verification',
          providerAccountId: 'acct-b',
          credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
          credentialFingerprint: 'sha256:bbbbbbbb',
        },
      },
    });
  });

  it('preserves a superseding C generation as an immutable reconciliation fact', () => {
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committed,
      result: { status: 'superseded_after_apply', activeProfileId: 'profile-c', generation: 3 },
    })).toEqual(expect.objectContaining({
      reconciliationDisposition: 'superseded_after_apply',
      errorCode: null,
      authoritativeGeneration: expect.objectContaining({
        provenance: 'reconciliation',
        decisionCommittedTarget: {
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'profile-c',
          generation: 3,
          credentialRevision: null,
        },
      }),
    }));
  });

  it('preserves the exact authoritative revision for a revision-only superseding epoch', () => {
    const committedRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
    const authoritativeRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const committedWithRevision = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-b-revision-only',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'profile-b',
        generation: 2,
        credentialRevision: committedRevision,
      },
    });
    const supersededResult = {
      status: 'superseded_after_apply',
      activeProfileId: 'profile-b',
      generation: 2,
      credentialRevision: authoritativeRevision,
      adoptedCredentialRevision: committedRevision,
    };

    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committedWithRevision,
      result: supersededResult,
    })).toMatchObject({
      reconciliationDisposition: 'superseded_after_apply',
      errorCode: null,
      authoritativeGeneration: {
        decisionCommittedTarget: {
          serviceId: 'openai-codex',
          groupId: 'team',
          profileId: 'profile-b',
          generation: 2,
          credentialRevision: authoritativeRevision,
        },
      },
    });
  });

  it('fails typed when the recipient apply does not prove a usable generation', () => {
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committed,
      result: { status: 'session_not_found', errorCode: 'session_not_found' },
    })).toEqual({ reconciliationDisposition: 'failed', errorCode: 'session_not_found' });
  });

  it('maps execution-authority restart refusal to durable deferral', () => {
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committed,
      result: {
        status: 'generation_apply_failed',
        errorCode: 'restart_disallowed_by_execution_policy',
      },
    })).toEqual({
      reconciliationDisposition: 'deferred_restart',
      errorCode: 'restart_disallowed_by_execution_policy',
      restartRequested: false,
    });
  });

  it('records next-spawn observation as deferred instead of inferring provider adoption', () => {
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committed,
      result: {
        status: 'observed_generation',
        activeProfileId: 'profile-b',
        generation: 2,
        mode: 'spawn_next_turn',
        providerApplication: 'observed',
      },
    })).toEqual({
      reconciliationDisposition: 'deferred_restart',
      errorCode: null,
      restartRequested: false,
    });
  });

  it('marks a deferred recipient as restart-requested only when the apply actually chose restart', () => {
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committed,
      result: {
        status: 'observed_generation',
        activeProfileId: 'profile-b',
        generation: 2,
        mode: 'restart_resume',
        providerApplication: 'observed',
      },
    })).toEqual({
      reconciliationDisposition: 'deferred_restart',
      errorCode: null,
      restartRequested: true,
    });
  });

  it('does not infer provider adoption proof from matching requested generation fields', () => {
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committed,
      result: { status: 'observed_generation', activeProfileId: 'profile-b', generation: 2 },
    })).toEqual({ reconciliationDisposition: 'deferred_restart', errorCode: null, restartRequested: false });
  });

  it('preserves exact shared-auth-surface adoption proof for providers without an account id', () => {
    const revision = 'csr_2123456789ABCDEFGHJKMNPQRS';
    const committedWithRevision = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-b-revision',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'profile-b',
        generation: 2,
        credentialRevision: revision,
      },
    });
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committedWithRevision,
      result: {
        status: 'observed_generation',
        activeProfileId: 'profile-b',
        generation: 2,
        mode: 'hot_apply',
        providerApplication: 'applied',
        verificationByServiceId: {
          'openai-codex': {
            status: 'verified',
            proofStrength: 'exact',
            sharedAuthSurfaceId: 'surface-b',
            credentialRevision: revision,
            credentialFingerprint: 'sha256:abcdef12',
            source: 'shared_auth_surface',
            generationApplication: {
              serviceId: 'openai-codex',
              groupId: 'team',
              profileId: 'profile-b',
              generation: 2,
              credentialRevision: revision,
              credentialFingerprint: 'sha256:abcdef12',
            },
          },
        },
      },
    })).toMatchObject({
      reconciliationDisposition: 'converged',
      providerAdoptedTarget: {
        proof: {
          status: 'verified',
          source: 'shared_auth_surface',
          sharedAuthSurfaceId: 'surface-b',
          credentialRevision: revision,
          credentialFingerprint: 'sha256:abcdef12',
        },
      },
    });
  });

  it.each([
    ['missing generation application', undefined],
    ['mismatched credential revision', {
      serviceId: 'openai-codex',
      groupId: 'team',
      profileId: 'profile-b',
      generation: 2,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      credentialFingerprint: 'sha256:aaaaaaaa',
    }],
  ] as const)('does not stamp the committed revision from %s proof', (_label, generationApplication) => {
    const committedRevision = 'csr_bbbbbbbbbbbbbbbbbbbbbb';
    const committedWithRevision = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-b-aba',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'profile-b',
        generation: 2,
        credentialRevision: committedRevision,
      },
    });

    const verification = generationApplication === undefined
      ? {
          status: 'verified' as const,
          proofStrength: 'exact' as const,
          providerAccountId: 'acct-b',
          credentialRevision: committedRevision,
        }
      : {
          status: 'verified' as const,
          proofStrength: 'exact' as const,
          providerAccountId: 'acct-b',
          credentialRevision: committedRevision,
          generationApplication,
        };
    expect(mapCommittedGenerationApplyResult({
      committedGeneration: committedWithRevision,
      result: {
        status: 'observed_generation',
        activeProfileId: 'profile-b',
        generation: 2,
        mode: 'hot_apply',
        providerApplication: 'applied',
        verificationByServiceId: {
          'openai-codex': verification,
        },
      },
    })).toEqual({
      reconciliationDisposition: 'deferred_restart',
      errorCode: null,
      restartRequested: false,
    });
  });
});
