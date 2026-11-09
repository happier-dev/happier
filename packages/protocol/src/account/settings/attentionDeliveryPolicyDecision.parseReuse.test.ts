import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttentionDeliveryPolicyV1Schema, DEFAULT_ATTENTION_DELIVERY_POLICY_V1 } from './attentionDeliveryPolicy.js';
import { resolveAttentionDeliveryPolicyDecision } from './attentionDeliveryPolicyDecision.js';

const decide = (policy: unknown) => resolveAttentionDeliveryPolicyDecision({
  policy,
  event: 'ready',
  channel: 'home_widget',
  now: new Date('2026-11-05T12:00:00.000Z'),
});

describe('attention delivery policy parsing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses one policy object once across a surface pass over many candidates', () => {
    const policy = AttentionDeliveryPolicyV1Schema.parse({});
    const safeParse = vi.spyOn(AttentionDeliveryPolicyV1Schema, 'safeParse');

    const first = decide(policy);
    for (let candidate = 0; candidate < 200; candidate += 1) decide(policy);

    expect(safeParse).toHaveBeenCalledTimes(1);
    expect(decide(policy)).toEqual(first);
  });

  it('decides each distinct policy object from its own contents', () => {
    const enabled = AttentionDeliveryPolicyV1Schema.parse({});
    const disabled = AttentionDeliveryPolicyV1Schema.parse({ events: { ready: { enabled: false } } });

    expect(decide(enabled).reason).toBe('deliver');
    expect(decide(disabled).reason).toBe('event_disabled');
    expect(decide(enabled).reason).toBe('deliver');
  });

  it('falls back to the default policy for invalid input, without retaining non-objects', () => {
    const invalid = { quietHours: 'not-a-policy' };
    const expected = decide(DEFAULT_ATTENTION_DELIVERY_POLICY_V1);

    expect(decide(invalid)).toEqual(expected);
    expect(decide(invalid)).toEqual(expected);
    expect(decide(null)).toEqual(expected);
    expect(decide('nope')).toEqual(expected);
  });
});
