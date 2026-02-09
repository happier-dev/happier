import { describe, expect, it } from 'vitest';
import { parseAndStripTerminalRuntimeFlags } from './terminalRuntimeFlags';

describe('parseAndStripTerminalRuntimeFlags', () => {
  it('extracts tmux runtime info and strips internal flags from argv', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      'claude',
      '--happy-terminal-mode',
      'tmux',
      '--happy-tmux-target',
      'happy:win-123',
      '--happy-tmux-tmpdir',
      '/tmp/happy-tmux',
      '--model',
      'sonnet',
    ]);

    expect(parsed).toEqual({
      terminal: {
        mode: 'tmux',
        tmuxTarget: 'happy:win-123',
        tmuxTmpDir: '/tmp/happy-tmux',
      },
      argv: ['claude', '--model', 'sonnet'],
    });
  });

  it('extracts fallback info when tmux was requested but plain mode was used', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      '--happy-terminal-mode',
      'plain',
      '--happy-terminal-requested',
      'tmux',
      '--happy-terminal-fallback-reason',
      'tmux not available',
      '--foo',
      'bar',
    ]);

    expect(parsed).toEqual({
      terminal: {
        mode: 'plain',
        requested: 'tmux',
        fallbackReason: 'tmux not available',
      },
      argv: ['--foo', 'bar'],
    });
  });

  it('does not swallow following flags when runtime flags are missing values', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      '--happy-terminal-mode',
      '--foo',
      'bar',
    ]);

    expect(parsed).toEqual({
      terminal: null,
      argv: ['--foo', 'bar'],
    });
  });

  it('does not consume single-dash tokens as runtime flag values', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      '--happy-terminal-mode',
      '-v',
      'claude',
    ]);

    expect(parsed).toEqual({
      terminal: null,
      argv: ['-v', 'claude'],
    });
  });

  it('strips unknown runtime values while keeping non-runtime args', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      '--happy-terminal-mode',
      'invalid-mode',
      '--happy-terminal-requested',
      'invalid-requested',
      '--verbose',
    ]);

    expect(parsed).toEqual({
      terminal: null,
      argv: ['--verbose'],
    });
  });
});
