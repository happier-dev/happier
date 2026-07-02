import { describe, expect, it } from 'vitest';

import {
  readMemorySynopsisPointerV1FromSessionMetadata,
} from './memorySynopsisPointerV1';

describe('memorySynopsisPointerV1', () => {
  it('reads a legacy metadata pointer with deterministic localId', () => {
    const pointer = readMemorySynopsisPointerV1FromSessionMetadata({
      memorySynopsisPointerV1: {
        v: 1,
        localId: 'memory:synopsis:v1:10',
        seqTo: 10,
        updatedAtMs: 99,
      },
    });
    expect(pointer).toEqual({
      v: 1,
      localId: 'memory:synopsis:v1:10',
      seqTo: 10,
      updatedAtMs: 99,
    });
  });

  it('rejects malformed legacy metadata pointers', () => {
    expect(readMemorySynopsisPointerV1FromSessionMetadata({
      memorySynopsisPointerV1: {
        v: 1,
        localId: '',
        seqTo: 10,
        updatedAtMs: 99,
      },
    })).toBeNull();
    expect(readMemorySynopsisPointerV1FromSessionMetadata({
      memorySynopsisPointerV1: {
        v: 1,
        localId: 'memory:synopsis:v1:10',
        seqTo: '10',
        updatedAtMs: 99,
      },
    })).toBeNull();
  });

  it('normalizes numeric legacy pointer fields', () => {
    const pointer = readMemorySynopsisPointerV1FromSessionMetadata({
      memorySynopsisPointerV1: {
        v: 1,
        localId: 'memory:synopsis:v1:20',
        seqTo: 20.8,
        updatedAtMs: 200.4,
      },
    });

    expect(pointer?.seqTo).toBe(20);
    expect(pointer?.updatedAtMs).toBe(200);
  });
});
