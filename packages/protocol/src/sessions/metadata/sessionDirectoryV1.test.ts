import { describe, expect, it } from 'vitest';
import { readSessionDirectoryKind, SessionDirectoryV1Schema } from '@happier-dev/protocol/sessions/metadata/directory';

describe('session directory classification', () => {
  it('classifies known persisted marker fields while keeping marker inputs strict', () => {
    const read = readSessionDirectoryKind;
    expect(read({ path: '/Users/alice/project', machineId: 'machine-1' })).toBe('path');
    expect(read({ path: '/private/allocation', sessionDirectoryV1: { v: 1, kind: 'managed' } })).toBe('managed');
    const additiveMarker = { v: 1, kind: 'managed', path: '/fake' };
    expect(read({ sessionDirectoryV1: additiveMarker })).toBe('managed');
    expect(SessionDirectoryV1Schema.safeParse(additiveMarker).success).toBe(false);
    for (const marker of [null, { v: 2, kind: 'managed' }, { v: 1, kind: 'path' }]) {
      expect(read({ sessionDirectoryV1: marker })).toBe('path');
    }
    expect(read(null)).toBe('path');
  });
});
