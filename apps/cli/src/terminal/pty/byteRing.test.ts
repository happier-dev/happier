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

  it.each([{ maxBytes: 6, maxChunks: 10 }, { maxBytes: 1024, maxChunks: 2 }])('bounds retained bytes by the byte/chunk budget (%j)', limits => {
    const ring = createTerminalByteRing(limits);

    ring.write(Buffer.from('old'));
    ring.write(Buffer.from('new'));
    ring.write(Buffer.from('end'));

    const read = ring.read({ byteOffset: 0, maxBytes: 1024, maxChunks: 10 });
    expect(read.availableByteOffset).toBe(9);
    expect(read.gap).toEqual({
      droppedBeforeByteOffset: 3,
      nextAvailableByteOffset: 3,
      reason: 'ring_overflow',
    });
    expect(Buffer.concat(read.chunks.map((chunk) => chunk.bytes)).toString('utf8')).toBe('newend');
    expect(read.nextByteOffset).toBe(9);
    expect(read.droppedBeforeByteOffset).toBe(3);
  });
});
