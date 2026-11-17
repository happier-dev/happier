import { describe, expect, it } from 'vitest';

import { ReviewStartInputSchema } from './reviewStart.js';

describe('ordered Review reviewer admission', () => {
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
