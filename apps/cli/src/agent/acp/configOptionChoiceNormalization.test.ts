import { describe, expect, it } from 'vitest';

import { normalizeAcpConfigOptionChoices, resolveAcpModelConfigOption } from './configOptionChoiceNormalization';
import { createFx014SessionResponse } from './testkit/fx014';

describe('resolveAcpModelConfigOption', () => {
  it('prefers an exact declared opaque id over the ordinary model label', () => {
    const options = createFx014SessionResponse().configOptions;
    const explicit = { ...options[1], id: ' vendor/MODEL ', name: 'Custom selection' };
    const candidates = [...options, explicit];
    expect(resolveAcpModelConfigOption(candidates, explicit.id)).toBe(explicit);
    expect(resolveAcpModelConfigOption(candidates, 'vendor/MODEL')).toBe(options[1]);
  });

  it('supports a single category-only selector without guessing between several', () => {
    const first = { id: 'vendor-choice', name: 'Engine', category: 'model', type: 'enum', options: [] };
    const other = { ...first, id: 'other-choice' };
    expect(resolveAcpModelConfigOption([first])).toBe(first);
    expect(resolveAcpModelConfigOption([first, other])).toBeNull();
    expect(resolveAcpModelConfigOption([other, first])).toBeNull();
    expect(resolveAcpModelConfigOption([{ ...first, type: 'boolean', options: undefined }, first])).toBe(first);
  });

  it('requires an unambiguous model identity and a selector with choices', () => {
    const [provider, model] = createFx014SessionResponse().configOptions;
    expect(resolveAcpModelConfigOption([provider, model])).toBe(model);
    expect(resolveAcpModelConfigOption([model, { ...model, id: 'other' }])).toBeNull();
    expect(resolveAcpModelConfigOption([{ ...model, type: 'boolean', options: undefined }, provider])).toBe(provider);
    expect(resolveAcpModelConfigOption([])).toBeNull();
  });

  it('preserves grouped choices recursively and their opaque model values', () => {
    const model = { id: 'custom', name: 'Model', type: 'select', options: [
      { name: 'Outer', options: [{ name: 'Inner', options: [
        { value: ' vendor/model ', name: 'Exact model' },
      ] }] },
    ] };
    const resolved = resolveAcpModelConfigOption([model]);
    expect(normalizeAcpConfigOptionChoices(resolved?.options, (value) => typeof value === 'string' ? value : null))
      .toEqual([{ value: ' vendor/model ', name: 'Exact model' }]);
  });
});
