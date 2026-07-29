import { describe, expect, it } from 'vitest';

import {
  QualifiedConnectedAccountPurposeBindingV1Schema,
  QualifiedConnectedAccountPurposeBindingsV1Schema,
} from './connectedAccountPurposeBindings.js';

const consumer = {
  pluginId: 'happier.agent.opencode',
  localId: 'opencode',
} as const;

const service = {
  pluginId: 'happier.connected-account.test',
  localId: 'subscription',
} as const;

describe('qualified connected-account purpose bindings', () => {
  it('represents fixed-account and group intent without a launch-selected group member', () => {
    expect(QualifiedConnectedAccountPurposeBindingV1Schema.parse({
      purpose: { consumer, purpose: 'model-openai' },
      target: { kind: 'account', account: { service, accountId: 'work' } },
    })).toEqual({
      purpose: { consumer, purpose: 'model-openai' },
      target: { kind: 'account', account: { service, accountId: 'work' } },
    });

    const group = QualifiedConnectedAccountPurposeBindingV1Schema.parse({
      purpose: { consumer, purpose: 'model-anthropic' },
      target: { kind: 'group', service, groupId: 'fallbacks' },
    });
    expect(group.target).toEqual({ kind: 'group', service, groupId: 'fallbacks' });
    expect(group.target).not.toHaveProperty('accountId');
    expect(group.target).not.toHaveProperty('profileId');
    expect(group.target).not.toHaveProperty('generation');
  });

  it('rejects two selectors for the same qualified consumer purpose', () => {
    expect(QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse({
      v: 1,
      bindings: [
        {
          purpose: { consumer, purpose: 'model-openai' },
          target: { kind: 'account', account: { service, accountId: 'one' } },
        },
        {
          purpose: { consumer, purpose: 'model-openai' },
          target: { kind: 'group', service, groupId: 'two' },
        },
      ],
    }).success).toBe(false);
  });

  it('is strict and does not accept legacy service-keyed maps as another authority', () => {
    expect(QualifiedConnectedAccountPurposeBindingsV1Schema.safeParse({
      v: 1,
      bindings: [],
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'default' },
      },
    }).success).toBe(false);
  });
});
