import { describe, expect, it } from 'vitest';

import {
  buildPiBrokerMarker,
  isPiBrokerMarker,
  parsePiBrokerSelections,
  piBrokerServiceId,
  piRegisterProviderId,
  serializePiBrokerSelections,
} from './env.js';

describe('pi broker env contract (shared bridge tag ⇄ Pi provider id)', () => {
  it('maps the shared bridge tag to the connected service id and Pi register provider id', () => {
    expect(piBrokerServiceId('openai')).toBe('openai-codex');
    expect(piBrokerServiceId('anthropic')).toBe('claude-subscription');
    expect(piRegisterProviderId('openai')).toBe('openai-codex');
    expect(piRegisterProviderId('anthropic')).toBe('anthropic');
  });

  it('builds and recognises a non-secret broker marker', () => {
    const marker = buildPiBrokerMarker('anthropic', '1');
    expect(marker).toBe('happier-pi-broker:anthropic:1');
    expect(isPiBrokerMarker(marker)).toBe(true);
    expect(isPiBrokerMarker('sk-ant-oat-real-token')).toBe(false);
    expect(isPiBrokerMarker(null)).toBe(false);
  });

  it('round-trips selections keyed by the shared bridge tag and drops mismatched service ids', () => {
    const selections = {
      anthropic: { serviceId: 'claude-subscription' as const, profileId: 'c', accountId: 'a', planType: null },
      openai: { serviceId: 'openai-codex' as const, profileId: 'x', accountId: null, planType: 'pro' },
    };
    expect(parsePiBrokerSelections(serializePiBrokerSelections(selections))).toEqual(selections);
    // A selection whose serviceId does not match its bridge tag is rejected.
    expect(parsePiBrokerSelections(JSON.stringify({
      anthropic: { serviceId: 'openai-codex', profileId: 'c', accountId: null, planType: null },
    }))).toEqual({});
    expect(parsePiBrokerSelections('not json')).toEqual({});
    expect(parsePiBrokerSelections(undefined)).toEqual({});
  });
});
