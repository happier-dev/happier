import { describe, expect, it } from 'vitest';

import { sanitizeDaemonEnvForSpawn } from './daemon';

describe('sanitizeDaemonEnvForSpawn', () => {
  it('defaults daemon test spawns to disabled caffeinate while stripping session-only env', () => {
    const env = sanitizeDaemonEnvForSpawn({
      PATH: '/usr/bin',
      HAPPIER_SESSION_ATTACH_FILE: '/tmp/attach.json',
      HAPPIER_STACK_TOOL_TRACE_FILE: '/tmp/trace.json',
      TMUX: 'tmux-123',
    });

    expect(env.HAPPIER_DISABLE_CAFFEINATE).toBe('1');
    expect(env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
    expect(env.HAPPIER_STACK_TOOL_TRACE_FILE).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});
