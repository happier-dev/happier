import { describe, expect, it } from 'vitest';

import { DaemonTerminalEnsureRequestSchema } from './terminal';

describe('DaemonTerminalEnsureRequestSchema', () => {
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
