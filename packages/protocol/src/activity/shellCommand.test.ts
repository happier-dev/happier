import { describe, expect, it } from 'vitest';

import { extractShellCommand, stripShellCommandPreludeForDisplay } from './shellCommand.js';

describe('extractShellCommand', () => {
  it('extracts a command from argv arrays', () => {
    expect(extractShellCommand(JSON.stringify({ argv: ['/bin/bash', '-lc', 'ls -la'] }))).toBe('ls -la');
  });

  it('extracts nested commands from toolCall.rawInput', () => {
    expect(
      extractShellCommand(JSON.stringify({ toolCall: { rawInput: { command: ['/bin/zsh', '-lc', 'git status'] } } })),
    ).toBe('git status');
  });

  it('extracts a command from raw argv arrays', () => {
    expect(extractShellCommand(['echo', 'hi'])).toBe('echo hi');
  });

  it('returns null for malformed or non-object inputs', () => {
    expect(extractShellCommand('{not-json')).toBeNull();
    expect(extractShellCommand('hello')).toBeNull();
  });
});

describe('stripShellCommandPreludeForDisplay', () => {
  it('removes env assignments and unset prelude noise', () => {
    expect(
      stripShellCommandPreludeForDisplay(
        'FOO=bar unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; git status --short',
      ),
    ).toBe('git status --short');
  });
});
