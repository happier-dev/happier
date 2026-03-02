import { describe, expect, it } from 'vitest';

import {
  applyMemorySynopsisPointerV1ToSessionMetadata,
  readMemorySynopsisPointerV1FromSessionMetadata,
} from './memorySynopsisPointerV1';

describe('memorySynopsisPointerV1', () => {
  it('writes a pointer with deterministic localId', () => {
    const updated = applyMemorySynopsisPointerV1ToSessionMetadata({
      metadata: {},
      next: { seqTo: 10, updatedAtMs: 99 },
    });

    const pointer = readMemorySynopsisPointerV1FromSessionMetadata(updated);
    expect(pointer).toEqual({
      v: 1,
      localId: 'memory:synopsis:v1:10',
      seqTo: 10,
      updatedAtMs: 99,
    });
  });

  it('does not regress when an older pointer is applied', () => {
    const base = applyMemorySynopsisPointerV1ToSessionMetadata({
      metadata: {},
      next: { seqTo: 20, updatedAtMs: 200 },
    });

    const updated = applyMemorySynopsisPointerV1ToSessionMetadata({
      metadata: base,
      next: { seqTo: 10, updatedAtMs: 199 },
    });

    expect(readMemorySynopsisPointerV1FromSessionMetadata(updated)?.seqTo).toBe(20);
  });

  it('does not rewrite when applying the same pointer payload', () => {
    const base = applyMemorySynopsisPointerV1ToSessionMetadata({
      metadata: {},
      next: { seqTo: 20, updatedAtMs: 200 },
    });

    const updated = applyMemorySynopsisPointerV1ToSessionMetadata({
      metadata: base,
      next: { seqTo: 20, updatedAtMs: 200 },
    });

    expect(updated).toBe(base);
  });
});

