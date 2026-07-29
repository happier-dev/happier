import { describe, expect, it } from 'vitest';

import {
  buildConnectedServiceAuthGroupCommittedGenerationFact,
  finalizeConnectedServiceAuthGenerationApplication,
} from './connectedServiceAuthSwitchOutcome';

describe('connectedServiceAuthSwitchOutcome', () => {
  it('keeps failure/requested/committed/normalized/adopted/final epochs distinct', () => {
    const committed = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-1',
      provenance: 'hard_limit',
      observedFailureSource: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'source',
        generation: 1,
        credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
        observedAtMs: 100,
        failureKind: 'usage_limit',
      },
      requestedTarget: { profileId: 'requested' },
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'committed',
        generation: 2,
        credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
      },
    });

    const outcome = finalizeConnectedServiceAuthGenerationApplication({
      sessionId: 'session-1',
      committedGeneration: committed,
      normalizedAtApplyTarget: committed.decisionCommittedTarget,
      providerAdoptedTarget: {
        ...committed.decisionCommittedTarget,
        proof: {
          status: 'verified',
          source: 'provider_read',
          credentialRevision: 'csr_2123456789ABCDEFGHJKMNPQRS',
          credentialFingerprint: 'sha256:provider-readable',
        },
      },
      observedAfterApplyTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'newer',
        generation: 3,
        credentialRevision: 'csr_3123456789ABCDEFGHJKMNPQRS',
      },
    });

    expect(outcome.reconciliationDisposition).toBe('superseded_after_apply');
    expect(outcome.committedGeneration.observedFailureSource?.generation).toBe(1);
    expect(outcome.committedGeneration.requestedTarget?.profileId).toBe('requested');
    expect(outcome.committedGeneration.decisionCommittedTarget.generation).toBe(2);
    expect(outcome.providerAdoptedTarget?.generation).toBe(2);
    expect(outcome.observedAfterApplyTarget.generation).toBe(3);
  });

  it('requires provider proof before reporting convergence', () => {
    const committed = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'decision-2',
      provenance: 'manual',
      decisionCommittedTarget: {
        serviceId: 'anthropic',
        groupId: 'team',
        profileId: 'next',
        generation: 8,
        credentialRevision: 'csr_8123456789ABCDEFGHJKMNPQRS',
      },
    });

    const withoutProof = finalizeConnectedServiceAuthGenerationApplication({
      sessionId: 'session-2',
      committedGeneration: committed,
      normalizedAtApplyTarget: committed.decisionCommittedTarget,
      providerAdoptedTarget: null,
      observedAfterApplyTarget: committed.decisionCommittedTarget,
    });
    expect(withoutProof.reconciliationDisposition).toBe('failed');
    expect(withoutProof.errorCode).toBe('provider_adoption_unproven');
  });

  it('never reports adoption when the desired revision is missing or provider proof names another revision', () => {
    const unknownRevision = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'old-shape',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'same',
        generation: 9,
        credentialRevision: null,
      },
    });
    const wrongRevision = buildConnectedServiceAuthGroupCommittedGenerationFact({
      decisionId: 'aba',
      provenance: 'reconciliation',
      decisionCommittedTarget: {
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'same',
        generation: 9,
        credentialRevision: 'csr_9123456789ABCDEFGHJKMNPQRS',
      },
    });

    expect(finalizeConnectedServiceAuthGenerationApplication({
      sessionId: 'unknown',
      committedGeneration: unknownRevision,
      normalizedAtApplyTarget: unknownRevision.decisionCommittedTarget,
      providerAdoptedTarget: {
        ...unknownRevision.decisionCommittedTarget,
        proof: { status: 'verified', source: 'provider_read', credentialRevision: null },
      },
      observedAfterApplyTarget: unknownRevision.decisionCommittedTarget,
    })).toMatchObject({ reconciliationDisposition: 'failed', errorCode: 'credential_revision_unproven' });

    expect(finalizeConnectedServiceAuthGenerationApplication({
      sessionId: 'wrong',
      committedGeneration: wrongRevision,
      normalizedAtApplyTarget: wrongRevision.decisionCommittedTarget,
      providerAdoptedTarget: {
        ...wrongRevision.decisionCommittedTarget,
        proof: {
          status: 'verified',
          source: 'provider_read',
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        },
      },
      observedAfterApplyTarget: wrongRevision.decisionCommittedTarget,
    })).toMatchObject({ reconciliationDisposition: 'failed', errorCode: 'credential_revision_mismatch' });
  });
});
