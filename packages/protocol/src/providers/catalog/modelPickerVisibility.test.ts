import { describe, expect, it } from 'vitest';
import { resolveProviderModelPickerVisibility } from './modelPickerVisibility.js';

describe('Provider source visibility policy', () => {
  it('defaults direct/cloud/local/custom on and aggregators off, with sparse explicit overrides', () => {
    for (const kind of ['frontier', 'cloud', 'local', 'custom'] as const) {
      expect(resolveProviderModelPickerVisibility({ connectionId: 'pc_a', kind }).shown).toBe(true);
    }
    expect(resolveProviderModelPickerVisibility({ connectionId: 'pc_a', kind: 'aggregator' }).shown).toBe(false);
    expect(resolveProviderModelPickerVisibility({ connectionId: 'pc_a', kind: 'aggregator',
      modelPickerVisibilityByConnectionId: { pc_a: true } }).shown).toBe(true);
    expect(resolveProviderModelPickerVisibility({ connectionId: 'pc_a', kind: 'frontier',
      modelPickerVisibilityByConnectionId: { pc_a: false } }).shown).toBe(false);
  });
});
