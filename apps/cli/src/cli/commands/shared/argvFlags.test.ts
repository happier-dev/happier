import { describe, expect, it } from 'vitest';

import {
  hasFlag,
  readCommandPositionals,
  readFlagValue,
  readFlagValueUnlessFlagToken,
  readIntFlagValue,
  readRawFlagValue,
} from './argvFlags';

describe('long option parsing', () => {
  it.each([
    ['a separate value', ['command', '--ui', 'reactNative']],
    ['an equals-form value', ['command', '--ui=reactNative']],
  ])('reads %s through the same valued-option owner', (_label, argv) => {
    expect(readFlagValue(argv, '--ui')).toBe('reactNative');
  });

  it('supports equals-form values for another safe long option', () => {
    expect(readFlagValue(
      ['command', '--sdk-registry=https://registry.example.test'],
      '--sdk-registry',
    )).toBe('https://registry.example.test');
  });

  it('keeps boolean flags exact and reports missing valued options as absent', () => {
    expect(hasFlag(['command', '--json'], '--json')).toBe(true);
    expect(hasFlag(['command', '--json=false'], '--json')).toBe(false);
    expect(readFlagValue(['command', '--ui'], '--ui')).toBeNull();
    expect(readFlagValue(['command', '--ui='], '--ui')).toBeNull();
    expect(readFlagValueUnlessFlagToken(['command', '--ui', '--json'], '--ui')).toBeNull();
  });

  it('can preserve caller-owned flag bytes for Protocol validation', () => {
    expect(readRawFlagValue(['command', '--request-id', ' correlation '], '--request-id'))
      .toBe(' correlation ');
    expect(readRawFlagValue(['command', '--request-id=correlation'], '--request-id'))
      .toBe('correlation');
  });
});

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
