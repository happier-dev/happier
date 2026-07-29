import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { createTerminalByteRing } from './byteRing';

describe('createTerminalByteRing', () => {
  it('does not let future byte-offset reads skip later output', () => {
    const ring = createTerminalByteRing({ maxBytes: 1024, maxChunks: 10 });

    ring.write(Buffer.from('abc'));

    const futureRead = ring.read({ byteOffset: 99, maxBytes: 1024, maxChunks: 10 });
    expect(futureRead.chunks).toEqual([]);
    expect(futureRead.availableByteOffset).toBe(3);
    expect(futureRead.nextByteOffset).toBe(3);
    expect(futureRead.droppedBeforeByteOffset).toBe(0);

    ring.write(Buffer.from('def'));

    const nextRead = ring.read({ byteOffset: futureRead.nextByteOffset, maxBytes: 1024, maxChunks: 10 });
    expect(Buffer.concat(nextRead.chunks.map((chunk) => chunk.bytes)).toString('utf8')).toBe('def');
    expect(nextRead.nextByteOffset).toBe(6);
    expect(nextRead.availableByteOffset).toBe(6);
    expect(nextRead.droppedBeforeByteOffset).toBe(0);
  });

  it('bounds retained bytes by age', () => {
    let now = 0;
    const ringParams: Parameters<typeof createTerminalByteRing>[0] & { maxAgeMs: number } = {
      maxBytes: 1024,
      maxChunks: 10,
      maxAgeMs: 1000,
      now: () => now,
    };
    const ring = createTerminalByteRing(ringParams);

    ring.write(Buffer.from('old'));
    now = 1500;
    ring.write(Buffer.from('new'));

    const read = ring.read({ byteOffset: 0, maxBytes: 1024, maxChunks: 10 });
    expect(read.availableByteOffset).toBe(6);
    expect(read.gap).toEqual({
      droppedBeforeByteOffset: 3,
      nextAvailableByteOffset: 3,
      reason: 'ring_overflow',
    });
    expect(Buffer.concat(read.chunks.map((chunk) => chunk.bytes)).toString('utf8')).toBe('new');
    expect(read.nextByteOffset).toBe(6);
    expect(read.droppedBeforeByteOffset).toBe(3);
  });
});
