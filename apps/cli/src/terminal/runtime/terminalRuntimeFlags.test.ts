import { describe, expect, it } from 'vitest';
import { parseAndStripTerminalRuntimeFlags } from './terminalRuntimeFlags';

describe('parseAndStripTerminalRuntimeFlags', () => {
  it('preserves literal text after the option terminator while extracting preceding runtime flags', () => {
    const literal = ['--', '--happy-terminal-mode', 'tmux', '--happy-terminal-title', 'literal title'];
    expect(parseAndStripTerminalRuntimeFlags([
      'session', 'send', 'session-id', '--happy-terminal-mode', 'plain', ...literal,
    ])).toEqual({ terminal: { mode: 'plain' }, argv: ['session', 'send', 'session-id', ...literal] });
  });

  it('preserves the Herdr host selection and named session for a daemon-started runner', () => {
    expect(parseAndStripTerminalRuntimeFlags([
      'claude', '--happy-terminal-mode', 'herdr', '--happy-terminal-requested', 'herdr',
      '--happy-herdr-session-name', 'work terminals',
      '--happy-herdr-socket-path', '/admitted root/herdr.sock',
    ])).toEqual({
      terminal: { mode: 'herdr', requested: 'herdr', herdrSessionName: 'work terminals', herdrSocketPath: '/admitted root/herdr.sock' },
      argv: ['claude'],
    });
  });

  it('extracts tmux runtime info and strips internal flags from argv', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      'claude',
      '--happy-terminal-mode',
      'tmux',
      '--happy-tmux-target',
      'happy:win-123',
      '--happy-tmux-tmpdir',
      '/tmp/happy-tmux',
      '--happy-terminal-attachment-id',
      'attachment-123',
      '--model',
      'sonnet',
    ]);

    expect(parsed).toEqual({
      terminal: {
        mode: 'tmux',
        tmuxTarget: 'happy:win-123',
        tmuxTmpDir: '/tmp/happy-tmux',
        attachmentId: 'attachment-123',
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

  it('extracts windows terminal runtime info', () => {
    const parsed = parseAndStripTerminalRuntimeFlags([
      '--happy-terminal-mode',
      'windows_terminal',
      '--happy-terminal-requested',
      'windows_terminal',
      '--happy-terminal-window-id',
      'happy-session-1',
      '--happy-terminal-title',
      'Happier codex spawn-1',
      '--happy-terminal-launch-correlation',
      'ab'.repeat(16),
      '--foo',
      'bar',
    ]);

    expect(parsed).toEqual({
      terminal: {
        mode: 'windows_terminal',
        requested: 'windows_terminal',
        windowId: 'happy-session-1',
        title: 'Happier codex spawn-1',
      },
      argv: ['--foo', 'bar'],
    });
  });
});
