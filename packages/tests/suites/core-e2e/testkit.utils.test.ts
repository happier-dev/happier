import { describe, expect, it } from 'vitest';

import { parsePositiveInt } from '../../src/testkit/numbers';
import { yarnCommand, which } from '../../src/testkit/process/commands';
import { hasStringSubstring } from '../../src/testkit/providers/assertions';
import { countNewMessageUpdatesWithLocalId, hasNewMessageUpdateWithLocalId } from '../../src/testkit/updates';

describe('testkit utilities', () => {
  it('parsePositiveInt returns fallback for undefined/invalid/non-positive values', () => {
    expect(parsePositiveInt(undefined, 7)).toBe(7);
    expect(parsePositiveInt('nope', 7)).toBe(7);
    expect(parsePositiveInt('0', 7)).toBe(7);
    expect(parsePositiveInt('-1', 7)).toBe(7);
  });

  it('parsePositiveInt returns parsed positive ints', () => {
    expect(parsePositiveInt('1', 7)).toBe(1);
    expect(parsePositiveInt('42', 7)).toBe(42);
  });

  it('yarnCommand returns a yarn executable name', () => {
    expect(yarnCommand()).toContain('yarn');
  });

  it('which returns a path for an existing binary and null for missing binaries', () => {
    // Node must exist for these tests to run at all, so it should be discoverable.
    expect(which('node')).not.toBeNull();
    expect(which('definitely_not_a_real_bin_12345')).toBeNull();
  });

  it('hasStringSubstring detects nested substrings', () => {
    expect(hasStringSubstring({ a: ['hello world'] }, 'world')).toBe(true);
    expect(hasStringSubstring({ a: ['hello'] }, 'world')).toBe(false);
  });

  it('new-message update helpers find and count by localId', () => {
    const events: any[] = [
      { kind: 'connect', at: 0 },
      { kind: 'update', at: 1, payload: { body: { t: 'new-message', message: { localId: 'a' } } } },
      { kind: 'update', at: 2, payload: { body: { t: 'new-message', message: { localId: 'a' } } } },
      { kind: 'update', at: 3, payload: { body: { t: 'other' } } },
    ];
    expect(hasNewMessageUpdateWithLocalId(events as any, 'a')).toBe(true);
    expect(countNewMessageUpdatesWithLocalId(events as any, 'a')).toBe(2);
    expect(hasNewMessageUpdateWithLocalId(events as any, 'b')).toBe(false);
    expect(countNewMessageUpdatesWithLocalId(events as any, 'b')).toBe(0);
  });
});

