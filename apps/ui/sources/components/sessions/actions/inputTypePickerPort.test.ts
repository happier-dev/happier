import { describe, expect, it } from 'vitest';
import { createInputTypePickerPort } from './inputTypePickerPort';

describe('native reference input picker projection', () => {
  it('edits and validates UsageQuery through the host form instead of plugin resolution', async () => {
    const port = createInputTypePickerPort({
      resolveType: () => { throw new Error('Host query must not resolve a plugin'); },
      canOpenPicker: () => { throw new Error('Host query has no plugin picker'); },
      openPicker: async () => { throw new Error('Host query has no plugin picker'); },
      openHostPicker: async () => ({ kind: 'completed', input: { agents: ['b', 'a', 'b'], metric: 'cost' } }),
    });
    const field = { path: 'query', title: 'Usage', widget: 'json' as const, inputType: { hostType: 'usageQuery' as const } };
    expect(port.describe(field)).not.toBeNull();
    expect(await port.pick({ field, value: undefined, signal: new AbortController().signal })).toMatchObject({
      status: 'selected', value: { agents: ['a', 'b'], metric: 'cost' },
    });
    expect(await port.pick({ field, value: undefined, options: [], signal: new AbortController().signal }))
      .toMatchObject({ status: 'selected', value: { agents: ['a', 'b'], metric: 'cost' } });
    expect(await port.pick({ field, value: undefined, options: [{ value: { metric: 'tokens' }, label: 'Tokens' }],
      signal: new AbortController().signal })).toMatchObject({ status: 'error' });
  });
  it('offers no plugin picker for host Session and Workspace fields', () => {
    const port = createInputTypePickerPort({
      resolveType: () => { throw new Error('Host references must not resolve a plugin'); },
      canOpenPicker: () => { throw new Error('Host references have no plugin picker'); },
      openPicker: async () => { throw new Error('Host references have no plugin picker'); },
    });
    for (const hostType of ['session', 'workspace'] as const) expect(port.describe({
      path: 'source', title: 'Source', inputType: { hostType },
    })).toBeNull();
  });
});
