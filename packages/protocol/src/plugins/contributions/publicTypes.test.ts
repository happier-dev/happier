import { describe, expect, it } from 'vitest';

import {
  evaluatePluginPolicyExpressionV2,
  PluginPolicyExpressionV2Schema,
} from './publicTypes.js';

describe('PluginPolicyExpressionV2', () => {
  it('evaluates tri-state boolean algebra in the Protocol owner', () => {
    const expression = PluginPolicyExpressionV2Schema.parse({
      all: [
        { fact: 'host.platform', operator: 'equals', value: 'web' },
        { any: [
          { fact: 'host.feature', operator: 'enabled', value: 'preview' },
          { fact: 'session.exists', operator: 'equals', value: true },
        ] },
      ],
    });

    expect(evaluatePluginPolicyExpressionV2(expression, {
      'host.platform': 'web',
      'host.feature': ['preview'],
      'session.exists': false,
    })).toBe(true);
    expect(evaluatePluginPolicyExpressionV2(expression, {
      'host.platform': 'web',
      'session.exists': false,
    })).toBe(null);
    expect(evaluatePluginPolicyExpressionV2(expression, {
      'host.platform': 'ios',
    })).toBe(false);
  });

  it('keeps unknown facts distinct from false and applies not through tri-state', () => {
    expect(evaluatePluginPolicyExpressionV2(
      { not: { fact: 'session.capability', operator: 'contains', value: 'voice' } },
      {},
    )).toBe(null);
    expect(evaluatePluginPolicyExpressionV2(
      { not: { fact: 'session.capability', operator: 'contains', value: 'voice' } },
      { 'session.capability': [] },
    )).toBe(true);
  });
});
