import { describe, expect, it } from 'vitest';

import { normalizeShapeForBaseline, shapeOf } from '../../src/testkit/providers/shape';

describe('providers: baseline shape normalization', () => {
  it('treats provider-specific meta subtrees as opaque strings (_raw and _acp)', () => {
    const value = {
      input: {
        _raw: { nested: { a: 1 } },
        _acp: { kind: 'edit', rawInput: { filePath: '/tmp/x' }, title: 'edit' },
        description: 'human readable',
        stable: { ok: true },
      },
    };

    const normalized = normalizeShapeForBaseline(shapeOf(value));

    expect(normalized.t).toBe('object');
    const input = normalized.t === 'object' ? normalized.keys['input'] : null;
    expect(input && input.t === 'object' ? input.keys['_raw'] : null).toEqual({ t: 'string' });
    expect(input && input.t === 'object' ? input.keys['_acp'] : null).toEqual({ t: 'string' });
    expect(input && input.t === 'object' ? input.keys['description'] : null).toBeUndefined();
  });

  it('keeps generic description fields outside tool-envelope normalization paths', () => {
    const value = {
      item: {
        description: 'semantic user content',
        value: 1,
      },
    };

    const normalized = normalizeShapeForBaseline(shapeOf(value));

    expect(normalized.t).toBe('object');
    const item = normalized.t === 'object' ? normalized.keys['item'] : null;
    expect(item && item.t === 'object' ? item.keys['description'] : null).toEqual({ t: 'string' });
  });

  it('samples array objects beyond the first element to build a less lossy item shape', () => {
    const normalized = normalizeShapeForBaseline(shapeOf([{ first: 1 }, { second: 'two' }]));

    expect(normalized.t).toBe('array');
    const item = normalized.t === 'array' ? normalized.item : null;
    expect(item && item.t === 'object' ? item.keys['first'] : null).toEqual({ t: 'number' });
    expect(item && item.t === 'object' ? item.keys['second'] : null).toEqual({ t: 'string' });
  });
});
