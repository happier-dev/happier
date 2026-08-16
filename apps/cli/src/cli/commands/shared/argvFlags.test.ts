import { describe, expect, it } from 'vitest';

import { readCommandPositionals, readIntFlagValue } from './argvFlags';

describe('readCommandPositionals', () => {
  it('excludes flags and their declared values from positional arguments', () => {
    expect(readCommandPositionals(
      ['wait', '--timeout', '15', '--json', 'session-id'],
      { startIndex: 1, valueFlags: ['--timeout'] },
    )).toEqual(['session-id']);
  });

  it('allows flag-looking positional values after the option terminator', () => {
    expect(readCommandPositionals(['send', 'session-id', '--', '--help'], { startIndex: 1 }))
      .toEqual(['session-id', '--help']);
  });
});

describe('readIntFlagValue', () => {
  it('returns null when the flag is absent and accepts zero when the caller allows it', () => {
    expect(readIntFlagValue(['command'], '--limit', { min: 1 })).toBeNull();
    expect(readIntFlagValue(['command', '--cursor', '0'], '--cursor', { min: 0 })).toBe(0);
  });

  it('rejects integers outside the JavaScript safe-integer range', () => {
    expect(() => readIntFlagValue(['command', '--limit', '9007199254740992'], '--limit'))
      .toThrow(expect.objectContaining({ code: 'invalid_arguments' }));
  });

  it.each([
    ['a missing value', ['command', '--limit']],
    ['a partial integer', ['command', '--limit', '10oops']],
    ['a value below the caller bound', ['command', '--limit', '0']],
    ['a value above the caller bound', ['command', '--limit', '201']],
  ])('rejects %s', (_label, argv) => {
    expect(() => readIntFlagValue(argv, '--limit', { min: 1, max: 200 }))
      .toThrow(expect.objectContaining({ code: 'invalid_arguments' }));
  });
});
