import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { createUtf8StreamDecoder, toPtyBytes } from './decode';

describe('terminal PTY byte decoding helpers', () => {
  it('copies Buffer and Uint8Array chunks into PTY byte buffers', () => {
    const original = Buffer.from([0x00, 0xff, 0x41]);
    const copied = toPtyBytes(original);

    original[2] = 0x42;

    expect(copied).toEqual(Buffer.from([0x00, 0xff, 0x41]));
    expect(toPtyBytes(new Uint8Array([0x61, 0x62]))).toEqual(Buffer.from('ab'));
    expect(toPtyBytes('€')).toEqual(Buffer.from('€', 'utf8'));
  });

  it('carries split UTF-8 sequences across chunks for legacy text projection', () => {
    const decoder = createUtf8StreamDecoder();

    expect(decoder.decode(Buffer.from([0xe2, 0x82]))).toBe('');
    expect(decoder.decode(Buffer.from([0xac]))).toBe('€');
    expect(decoder.flush()).toBe('');
  });

  it('flushes incomplete UTF-8 sequences as replacement characters', () => {
    const decoder = createUtf8StreamDecoder();

    expect(decoder.decode(Buffer.from([0xe2, 0x82]))).toBe('');
    expect(decoder.flush()).toBe('\ufffd');
  });
});
