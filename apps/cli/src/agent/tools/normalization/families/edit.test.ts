import { describe, expect, it } from 'vitest';

import { normalizeEditInput, normalizeEditResult } from './edit';

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

describe('normalizeEditResult', () => {
  it('extracts metadata.diff from auggie tool_use_diff JSON string output', () => {
    const normalized = normalizeEditResult(
      JSON.stringify({
        path: '/tmp/example.txt',
        action: 'Update',
        metrics: {
          tool_use_diff: {
            path: '/tmp/example.txt',
            edits: [
              {
                before_text: 'before-line',
                after_text: 'after-line',
                line_start: 0,
              },
            ],
          },
        },
      }),
    );

    const metadata = (normalized.metadata ?? {}) as Record<string, unknown>;
    expect(typeof metadata.diff).toBe('string');
    expect(String(metadata.diff)).toContain('--- a//tmp/example.txt');
    expect(String(metadata.diff)).toContain('+++ b//tmp/example.txt');
    expect(String(metadata.diff)).toContain('-before-line');
    expect(String(metadata.diff)).toContain('+after-line');
  });

  it('extracts metadata.diff from metadata.filediff before/after', () => {
    const normalized = normalizeEditResult({
      metadata: {
        filediff: {
          file: 'a.txt',
          before: 'old content',
          after: 'new content',
        },
      },
    });

    const metadata = (normalized.metadata ?? {}) as Record<string, unknown>;
    expect(typeof metadata.diff).toBe('string');
    expect(String(metadata.diff)).toContain('--- a/a.txt');
    expect(String(metadata.diff)).toContain('+++ b/a.txt');
    expect(String(metadata.diff)).toContain('-old content');
    expect(String(metadata.diff)).toContain('+new content');
  });

  it('extracts metadata.diff when ACP wrappers nest JSON under output string', () => {
    const normalized = normalizeEditResult({
      output: JSON.stringify({
        metrics: {
          tool_use_diff: {
            path: '/tmp/wrapped.txt',
            edits: [{ before_text: 'before', after_text: 'after', line_start: 0 }],
          },
        },
      }),
    });

    const metadata = (normalized.metadata ?? {}) as Record<string, unknown>;
    expect(typeof metadata.diff).toBe('string');
    expect(String(metadata.diff)).toContain('--- a//tmp/wrapped.txt');
    expect(String(metadata.diff)).toContain('+++ b//tmp/wrapped.txt');
    expect(String(metadata.diff)).toContain('-before');
    expect(String(metadata.diff)).toContain('+after');
  });

  it('promotes details.diff to metadata.diff for Pi-style edit results', () => {
    const normalized = normalizeEditResult({
      details: {
        diff: '-1 ONE\n+1 TWO',
      },
    });

    const metadata = (normalized.metadata ?? {}) as Record<string, unknown>;
    expect(metadata.diff).toBe('-1 ONE\n+1 TWO');
  });
});
