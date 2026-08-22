import { describe, expect, it } from 'vitest';

import { readCommandPositionals } from './argvFlags';

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
