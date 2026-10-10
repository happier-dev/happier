import { describe, expect, it } from 'vitest';
import { Children, isValidElement, type ReactNode } from 'react';
import { HappierFindHighlightedText, sliceFindRanges } from './FindHighlightedText.js';

describe('shared Find text ranges', () => {
  it('clips UTF-16 ranges and keeps the selected overlap distinct without duplicating text', () => {
    const marked: { text: string; current: boolean; backgroundColor: string }[] = [];
    const result = HappierFindHighlightedText({ text: '😀abcd!',
      ranges: [{ start: -2, end: 5, current: false }, { start: 3, end: 99, current: true }],
      marks: { all: { backgroundColor: 'all' }, current: { backgroundColor: 'current' } },
      renderMatch: ({ text, current, style }) => { marked.push({ text, current, backgroundColor: style.backgroundColor }); return text; },
    });
    expect(marked).toEqual([
      { text: '😀a', current: false, backgroundColor: 'all' },
      { text: 'bc', current: true, backgroundColor: 'current' },
      { text: 'd!', current: true, backgroundColor: 'current' },
    ]);
    if (!isValidElement<{ children: ReactNode }>(result)) throw new Error('Expected highlight segments');
    expect(Children.toArray(result.props.children).join('')).toBe('😀abcd!');
    expect(sliceFindRanges([{ start: 0, end: 5, current: false }, { start: 3, end: 7, current: true }], 2, 3))
      .toEqual([{ start: 0, end: 3, current: false }, { start: 1, end: 3, current: true }]);
  });
});
