import { describe, expect, it } from 'vitest';

import {
  PluginExecutionRunProfileActionReferenceV2Schema,
  PluginExecutionRunProfileContributionV2Schema,
} from './executionRunProfiles.js';

describe('PluginExecutionRunProfileActionReferenceV2Schema', () => {
  it('accepts contribution and canonical host action references', () => {
    expect(PluginExecutionRunProfileActionReferenceV2Schema.parse({
      kind: 'contributionAction', action: 'publish',
    })).toEqual({ kind: 'contributionAction', action: 'publish' });
    expect(PluginExecutionRunProfileActionReferenceV2Schema.parse({
      kind: 'hostAction', actionId: 'reviews.comments.create',
    })).toEqual({ kind: 'hostAction', actionId: 'reviews.comments.create' });
  });

  it('rejects bare and undeclared host action references', () => {
    expect(PluginExecutionRunProfileActionReferenceV2Schema.safeParse('publish').success).toBe(false);
    expect(PluginExecutionRunProfileActionReferenceV2Schema.safeParse({
      kind: 'hostAction', actionId: 'reviews.comments.delete',
    }).success).toBe(false);
  });
});

describe('PluginExecutionRunProfileContributionV2Schema', () => {
  it('requires the execution intent owned by the contributed profile', () => {
    const profile = {
      id: 'review',
      intent: 'review',
      title: 'Review',
      promptAsset: 'review-prompt',
      compatibleAgents: ['reviewer'],
      defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
    };

    expect(PluginExecutionRunProfileContributionV2Schema.parse(profile)).toEqual(profile);
    const { intent: _intent, ...withoutIntent } = profile;
    expect(PluginExecutionRunProfileContributionV2Schema.safeParse(withoutIntent).success).toBe(false);
  });
});
