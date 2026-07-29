import { describe, expect, it } from 'vitest';

import { DaemonTerminalEnsureRequestSchema } from './terminal';

describe('DaemonTerminalEnsureRequestSchema', () => {
  it('accepts a typed attached-session action and rejects a competing raw command', () => {
    expect(DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'session:dialog-attach',
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    })).toMatchObject({
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    });

    expect(DaemonTerminalEnsureRequestSchema.safeParse({
      terminalKey: 'session:dialog-attach',
      initialCommand: 'happier attach session-1',
      launch: { kind: 'session_attach', sessionId: 'session-1' },
    }).success).toBe(false);
  });
  it('accepts an optional sessionId attribution field', () => {
    const parsed = DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'terminal-a',
      cwd: '/repo/web',
      sessionId: 'session-a',
    });

    expect(parsed.sessionId).toBe('session-a');
  });

  it('omits sessionId when not supplied (back-compatible)', () => {
    const parsed = DaemonTerminalEnsureRequestSchema.parse({
      terminalKey: 'terminal-a',
      cwd: '/repo/web',
    });

    expect(parsed.sessionId).toBeUndefined();
  });

  it('rejects an empty sessionId', () => {
    const result = DaemonTerminalEnsureRequestSchema.safeParse({
      terminalKey: 'terminal-a',
      sessionId: '',
    });

    expect(result.success).toBe(false);
  });
});
