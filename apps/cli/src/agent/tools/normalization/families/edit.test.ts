import { describe, expect, it } from 'vitest';

import { normalizeEditInput } from './edit';

describe('normalizeEditInput', () => {
  it('derives file_path from ACP diff items[0].path when missing', () => {
    const normalized = normalizeEditInput({
      items: [{ path: '/tmp/a.txt', oldText: 'old', newText: 'new', type: 'diff' }],
    });

    expect(normalized.file_path).toBe('/tmp/a.txt');
    expect(normalized.old_string).toBe('old');
    expect(normalized.new_string).toBe('new');
  });

  it('derives file_path from ACP single locations entry when missing', () => {
    const normalized = normalizeEditInput({
      locations: [{ path: '/tmp/b.txt' }],
      oldText: 'a',
      newText: 'b',
    });

    expect(normalized.file_path).toBe('/tmp/b.txt');
  });

  it('keeps explicit file_path over items[] and locations[] fallbacks', () => {
    const normalized = normalizeEditInput({
      file_path: '/tmp/explicit.txt',
      items: [{ path: '/tmp/from-item.txt', oldText: 'old', newText: 'new' }],
      locations: [{ path: '/tmp/from-location.txt' }],
    });

    expect(normalized.file_path).toBe('/tmp/explicit.txt');
  });

  it('does not derive file_path from locations when more than one location is provided', () => {
    const normalized = normalizeEditInput({
      locations: [{ path: '/tmp/one.txt' }, { path: '/tmp/two.txt' }],
      oldText: 'a',
      newText: 'b',
    });

    expect(normalized.file_path).toBeUndefined();
  });

  it('normalizes replaceAll to replace_all', () => {
    const normalized = normalizeEditInput({
      path: '/tmp/replace.txt',
      oldText: 'a',
      newText: 'b',
      replaceAll: true,
    });

    expect(normalized.replace_all).toBe(true);
  });
});
