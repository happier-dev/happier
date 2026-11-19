import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import { createTerminalByteRing } from './byteRing';

describe('createTerminalByteRing', () => {
  it('copies only the bytes retained by a write and owns them independently of its caller', () => {
    const ring = createTerminalByteRing({ maxBytes: 4, maxChunks: 10 });
    const input = new Uint8Array([1, 2, 3, 4, 5, 6]);

    // Count bytes copied across Node's Buffer allocation boundary during the write.
    const copy = vi.spyOn(Buffer, 'from');
    const copiedBytes = (() => {
      try {
        ring.write(input);
        return copy.mock.calls.reduce((total, [value]) => {
          const input: unknown = value;
          return total + (input instanceof Uint8Array ? input.byteLength : 0);
        }, 0);
      } finally {
        copy.mockRestore();
      }
    })();
    expect(copiedBytes).toBe(4);

    input.fill(0);
    const replay = ring.read({ byteOffset: 0, maxBytes: 4, maxChunks: 10 });
    expect(replay.gap?.nextAvailableByteOffset).toBe(2);
    expect(replay.nextByteOffset).toBe(6);
    expect([...replay.chunks[0]!.bytes]).toEqual([3, 4, 5, 6]);
  });

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
