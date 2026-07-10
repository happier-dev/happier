import { describe, expect, it } from 'vitest';

import { splitBufferByBytes, splitStringByCodePoints } from './chunks';

describe('terminal host chunk helpers', () => {
  it('splits strings by code point so surrogate pairs stay intact', () => {
    expect(splitStringByCodePoints('a😀bc', 2)).toEqual(['a😀', 'bc']);
  });

  it('normalizes invalid string chunk sizes to one code point', () => {
    expect(splitStringByCodePoints('abc', 0)).toEqual(['a', 'b', 'c']);
  });

  it('splits buffers by byte length for byte-oriented hosts', () => {
    const chunks = splitBufferByBytes(Buffer.from([1, 2, 3, 4, 5]), 2);
    expect(chunks.map((chunk) => [...chunk])).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns no byte chunks for empty buffers', () => {
    expect(splitBufferByBytes(Buffer.alloc(0), 2)).toEqual([]);
  });
});
