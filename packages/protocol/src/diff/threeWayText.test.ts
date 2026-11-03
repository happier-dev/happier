import { describe, expect, it } from 'vitest';
import { compareThreeWayTextV1, resolveThreeWayTextV1 } from './threeWayText.js';

describe('three-way text review', () => {
  it('combines disjoint edits and asks only for overlapping different output', () => {
    const comparison = compareThreeWayTextV1('one\ntwo\nthree\nfour\n', 'mine\ntwo\nthree\nfour\n', 'author\ntwo\nthree\nnew four\n');
    expect(comparison.segments.filter(segment => segment.kind === 'conflict')).toHaveLength(1);
    expect(comparison.text).toBe('mine\ntwo\nthree\nnew four\n');
    const conflict = comparison.segments.find(segment => segment.kind === 'conflict')!;
    expect(resolveThreeWayTextV1(comparison, { [conflict.index]: 'theirs' })).toBe('author\ntwo\nthree\nnew four\n');
    expect(resolveThreeWayTextV1(comparison, { [conflict.index]: 'both' })).toBe('mine\nauthor\ntwo\nthree\nnew four\n');
  });
  it('preserves local insertions, upstream deletions and exact CRLF/EOF bytes', () => {
    expect(compareThreeWayTextV1('a\r\nb\r\nc', 'a\r\nlocal\r\nb\r\nc', 'a\r\nb\r\n').text).toBe('a\r\nlocal\r\nb\r\n');
    expect(compareThreeWayTextV1('a\n', 'a', 'a').text).toBe('a');
    const comparison = compareThreeWayTextV1('a\n', '', 'b');
    expect(comparison.segments[0]).toMatchObject({ kind: 'conflict', mine: '', theirs: 'b' });
    expect(resolveThreeWayTextV1(comparison, { 0: 'both' })).toBe('b');
  });
  it('keeps touching independent replacements separate and identical overlaps once', () => {
    expect(compareThreeWayTextV1('a\nb\n', 'mine\nb\n', 'a\nauthor\n').text).toBe('mine\nauthor\n');
    expect(compareThreeWayTextV1('a\nb\n', 'same\nb\n', 'same\nb\n').text).toBe('same\nb\n');
    expect(compareThreeWayTextV1('', 'mine', 'author').text).toBe('mine');
  });
});
