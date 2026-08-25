import { describe, expect, it } from 'vitest';

import { assertSessionCommandArguments } from './assertSessionCommandArguments';

const policy = {
  usage: 'Usage: happier session example <session-id> [--timeout <seconds>] [--json]',
  startIndex: 1,
  booleanFlags: ['--json'],
  valueFlags: ['--timeout'],
  maxPositionals: 1,
} as const;

describe('assertSessionCommandArguments', () => {
  it('rejects undeclared options and extra positional arguments before command execution', () => {
    expect(() => assertSessionCommandArguments(['example', 'sess-1', '--unknown'], policy))
      .toThrow('Unknown option: --unknown');
    expect(() => assertSessionCommandArguments(['example', 'sess-1', '-x'], policy))
      .toThrow('Unknown option: -x');
    expect(() => assertSessionCommandArguments(['example', 'sess-1', 'ignored'], policy))
      .toThrow('Unexpected argument: ignored');
  });

  it('requires declared value options to have a value and keeps boolean options valueless', () => {
    expect(() => assertSessionCommandArguments(['example', 'sess-1', '--timeout'], policy))
      .toThrow('Option --timeout requires a value.');
    expect(() => assertSessionCommandArguments(['example', 'sess-1', '--timeout', '-x'], policy))
      .toThrow('Option --timeout requires a value.');
    expect(() => assertSessionCommandArguments(['example', 'sess-1', '--timeout='], policy))
      .toThrow('Option --timeout requires a value.');
    expect(() => assertSessionCommandArguments(
      ['example', 'sess-1', '--timeout=30'],
      { ...policy, inlineValueFlags: [] },
    )).toThrow('Option --timeout does not accept an inline value.');
    expect(() => assertSessionCommandArguments(['example', 'sess-1', '--json=true'], policy))
      .toThrow('Option --json does not accept a value.');
  });

  it('keeps canonical usage after the specific rejection reason', () => {
    expect(() => assertSessionCommandArguments(['example', 'sess-1', '--unknown'], policy))
      .toThrow(`Unknown option: --unknown\n${policy.usage}`);
  });

  it('leaves designated missing values to the command-owned parser', () => {
    expect(() => assertSessionCommandArguments(
      ['example', 'sess-1', '--timeout'],
      { ...policy, allowMissingValueFlags: ['--timeout'] },
    )).not.toThrow();
  });

  it('marks rejected arguments as invalid_arguments for structured command callers', () => {
    try {
      assertSessionCommandArguments(['example', 'sess-1', '--unknown'], policy);
      throw new Error('Expected argument validation to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_arguments' });
    }
  });

  it('accepts declared boolean and value options alongside its positional argument', () => {
    expect(() => assertSessionCommandArguments(['example', 'sess-1', '--timeout', '30', '--json'], policy))
      .not.toThrow();
  });
});
