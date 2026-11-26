import { describe, expect, it } from 'vitest';

import { ReviewStartInputSchema, reviewReviewerIdentitiesForStartV1 } from './reviewStart.js';

describe('ordered Review reviewer admission', () => {
  it('uses the admitted catalog name for a reviewer with an explicitly selected engine model', () => {
    const input = ReviewStartInputSchema.parse({ reviewers: [{ kind: 'engine', engineId: 'muse',
      modelId: 'meta/muse-spark-1.3-contributor' }], instructions: 'Review.' });
    expect(reviewReviewerIdentitiesForStartV1(input, () => 'Muse').reviewerDisplayNames).toEqual({
      'step-1-reviewer-1': 'Muse',
    });
  });

  it('retains each engine member runner and account through Action JSON admission and identity projection', () => {
    const reviewers = [
      { kind: 'engine', engineId: 'roborev',
        runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        modelSelection: { agentTargetKey: 'backend:codex', providerConnectionId: 'provider-a', modelId: 'codex-review-model' },
        connectedServices: { selectedAccount: 'codex-account' } },
      { kind: 'engine', engineId: 'roborev',
        runnerAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        modelSelection: { agentTargetKey: 'backend:claude', providerConnectionId: null, modelId: 'claude-review-model' },
        connectedServices: { selectedAccount: 'claude-account' } },
    ];
    const parsed = ReviewStartInputSchema.parse(JSON.parse(JSON.stringify({ reviewers, instructions: 'Review.' })));
    expect(parsed.reviewers).toEqual(reviewers);
    expect(reviewReviewerIdentitiesForStartV1(parsed).reviewerAgentIds).toEqual({
      'step-1-reviewer-1': 'happier.agent.codex/codex',
      'step-1-reviewer-2': 'happier.agent.claude/claude',
    });
    expect(ReviewStartInputSchema.safeParse({ reviewers: [{ ...reviewers[0],
      runnerAgentTarget: { ...reviewers[0].runnerAgentTarget, command: 'private override' },
    }], instructions: 'Review.' }).success).toBe(false);
    expect(ReviewStartInputSchema.safeParse({ reviewers: [{ kind: 'engine', engineId: 'roborev',
      runnerAgentTarget: 'codex',
    }], instructions: 'Review.' }).success).toBe(false);
  });

  it('keeps additive launch metadata as JSON and refuses non-JSON reviewer launch values', () => {
    const selection = { kind: 'engine', engineId: 'codex', sessionConfigOptionOverrides: {
      v: 1, updatedAt: 1, overrides: {}, futureMetadata: { values: ['preserved', null] },
    } };
    const input = { reviewers: [selection], instructions: 'Review.' };
    expect(ReviewStartInputSchema.parse(input).reviewers).toEqual([selection]);
    expect(ReviewStartInputSchema.safeParse({ ...input, reviewers: [{ ...selection,
      sessionConfigOptionOverrides: { ...selection.sessionConfigOptionOverrides, futureMetadata: { callback: () => undefined } },
    }] }).success).toBe(false);
  });

  it('preserves JSON engine options and refuses values that cannot cross the Action transport', () => {
    const options = { nested: { focus: ['security', null], enabled: true, threshold: 0.5 } };
    const ordered = { reviewers: [{ kind: 'engine', engineId: 'codex', options }], instructions: 'Review.' };
    const historical = { engineIds: ['codex'], engines: { codex: options }, instructions: 'Review.' };
    expect(ReviewStartInputSchema.parse(ordered).reviewers?.[0]).toEqual(ordered.reviewers[0]);
    expect(ReviewStartInputSchema.parse(historical).engines).toEqual(historical.engines);
    for (const invalid of [{ callback: () => undefined }, { nested: { value: undefined } }, { value: Number.NaN }]) {
      expect(ReviewStartInputSchema.safeParse({ ...ordered, reviewers: [{ ...ordered.reviewers[0], options: invalid }] }).success).toBe(false);
      expect(ReviewStartInputSchema.safeParse({ ...historical, engines: { codex: invalid } }).success).toBe(false);
    }
  });

  it('retains independent selections when the same engine reviews twice beside a Session and person', () => {
    const reviewers = [
      { kind: 'engine', engineId: 'codex', modelId: 'first-model', options: { focus: 'security' } },
      { kind: 'engine', engineId: 'codex', modelId: 'second-model', options: { focus: 'correctness' } },
      { kind: 'session', session: { sessionId: 'reviewer-session', serverId: 'home-a' } },
      { kind: 'person', principal: { kind: 'account', accountId: 'requested-person' }, required: true },
    ];
    const parsed = ReviewStartInputSchema.parse({ reviewers, instructions: 'Review the changes.' });
    expect(parsed.reviewers).toEqual(reviewers);
    expect(parsed).not.toHaveProperty('engineIds');
  });

  it('admits human-only reviews without an executable selection and rejects participant impersonation', () => {
    expect(ReviewStartInputSchema.safeParse({ reviewers: [
      { kind: 'person', principal: { kind: 'team', teamId: 'review-team' }, required: false },
    ], instructions: 'Please review.' }).success).toBe(true);
    expect(ReviewStartInputSchema.safeParse({ reviewers: [
      { kind: 'session', session: { sessionId: 'reviewer-session', serverId: 'home-a' }, modelId: 'override' },
    ], instructions: 'Please review.' }).success).toBe(false);
    expect(ReviewStartInputSchema.safeParse({ reviewers: [], instructions: 'Please review.' }).success).toBe(false);
  });

  it('keeps Team credential consent on each exact engine selection', () => {
    const teamCredentialModel = {
      kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a',
      expectedResourceRevision: 4, agentTargetKey: 'backend:codex', modelId: 'review-model', deliveryMode: 'brokered',
    };
    const reviewer = { kind: 'engine', engineId: 'codex', teamCredentialModel,
      teamCredentialSessionBindingConsent: { v: 1, sessionId: 'parent-session', teamId: 'team-a',
        resourceId: 'resource-a', expectedResourceRevision: 4 } };
    const input = { sessionId: 'parent-session', reviewers: [reviewer, { kind: 'engine', engineId: 'claude' }],
      instructions: 'Review the changes.' };
    expect(ReviewStartInputSchema.safeParse(input).success).toBe(true);
    expect(ReviewStartInputSchema.safeParse({ ...input, reviewers: [
      { ...reviewer, teamCredentialSessionBindingConsent: { ...reviewer.teamCredentialSessionBindingConsent, expectedResourceRevision: 3 } },
    ] }).success).toBe(false);
  });
});
