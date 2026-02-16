import { describe, expect, it } from 'vitest';

import { parseConnectedServicesBindings } from './parseConnectedServicesBindings';

describe('parseConnectedServicesBindings', () => {
  it('returns connected bindings with profile ids', () => {
    const parsed = parseConnectedServicesBindings({
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', profileId: 'work' },
        anthropic: { source: 'native' },
      },
    });
    expect(parsed).toEqual([{ serviceId: 'openai-codex', profileId: 'work' }]);
  });

  it('returns an empty list for invalid payloads', () => {
    expect(parseConnectedServicesBindings(null)).toEqual([]);
    expect(parseConnectedServicesBindings({})).toEqual([]);
  });
});

