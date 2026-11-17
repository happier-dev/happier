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
  const profile = {
    id: 'review',
    intent: 'review',
    title: 'Review',
    promptAsset: 'review-prompt',
    compatibleAgents: ['reviewer'],
    defaults: { retention: 'ephemeral', runClass: 'bounded', io: 'streaming' },
  };

  it('requires the execution intent owned by the contributed profile', () => {
    expect(PluginExecutionRunProfileContributionV2Schema.parse(profile)).toEqual(profile);
    const { intent: _intent, ...withoutIntent } = profile;
    expect(PluginExecutionRunProfileContributionV2Schema.safeParse(withoutIntent).success).toBe(false);
  });

  it('retains declared controls and recursively closed option objects', () => {
    const optionsSchema = {
      type: 'object', additionalProperties: false,
      properties: {
        mode: { type: 'string', title: 'Review mode', enum: ['review', 'audit'] },
        targets: { type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: { path: { type: 'string' } }, required: ['path'],
        } },
      },
    };
    expect(PluginExecutionRunProfileContributionV2Schema.parse({ ...profile, optionsSchema }))
      .toEqual({ ...profile, optionsSchema });
  });

  it.each([
    ['non-object root', { type: 'string' }],
    ['open root', { type: 'object', additionalProperties: true }],
    ['open nested object', { type: 'object', additionalProperties: false,
      properties: { target: { type: 'object', properties: { path: { type: 'string' } } } } }],
    ['open array item', { type: 'object', additionalProperties: false,
      properties: { targets: { type: 'array', items: { type: 'object', additionalProperties: true } } } }],
    ['open union arm', { type: 'object', additionalProperties: false,
      properties: { target: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: true }] } } }],
    ['invalid schema type', { type: 'object', additionalProperties: false, properties: { mode: { type: 'unsupported' } } }],
  ])('rejects %s in option declarations', (_name, optionsSchema) => {
    expect(PluginExecutionRunProfileContributionV2Schema.safeParse({ ...profile, optionsSchema }).success).toBe(false);
  });
});
