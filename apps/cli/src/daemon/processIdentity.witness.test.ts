import { describe, expect, it } from 'vitest';
import { parseProcessGenerationWitness } from './processIdentity';

describe('process generation witness boundary', () => {
  it('projects the numeric birth witness from an observed process record', () => {
    expect(parseProcessGenerationWitness({ pid: 42, processStartTimeMs: 0, processCommand: 'existing record' }))
      .toEqual({ pid: 42, processStartTimeMs: 0 });
  });

  it.each([
    null, [], {}, { pid: 42 }, { pid: '42', processStartTimeMs: 1 },
    { pid: 0, processStartTimeMs: 1 }, { pid: -1, processStartTimeMs: 1 },
    { pid: 1.5, processStartTimeMs: 1 }, { pid: Number.MAX_SAFE_INTEGER + 1, processStartTimeMs: 1 },
    { pid: 42, processStartTimeMs: -1 }, { pid: 42, processStartTimeMs: '1' },
    { pid: 42, processStartTimeMs: 1.5 },
  ])('refuses an incomplete or non-integral generation witness: %j', value => {
    expect(parseProcessGenerationWitness(value)).toBeNull();
  });
});
