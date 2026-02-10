import { describe, expect, it } from 'vitest';

import { sanitizeDaemonEnvForSpawn } from '../../src/testkit/daemon/daemon';

describe('sanitizeDaemonEnvForSpawn', () => {
  it('removes tmux + per-session attach/trace env while preserving unrelated env', () => {
    const out = sanitizeDaemonEnvForSpawn({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      TMUX: '/tmp/tmux-1000/default,123,0',
      TMUX_PANE: '%42',
      TMUX_TMPDIR: '/tmp/custom-tmux',
      HAPPIER_HOME_DIR: '/tmp/happier',
      HAPPIER_SESSION_ATTACH_FILE: '/tmp/happier/attach.json',
      HAPPIER_STACK_TOOL_TRACE_FILE: '/tmp/trace.jsonl',
    });

    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/tmp/home');
    expect(out.HAPPIER_HOME_DIR).toBe('/tmp/happier');

    expect(Object.prototype.hasOwnProperty.call(out, 'TMUX')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'TMUX_PANE')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'TMUX_TMPDIR')).toBe(false);

    // Daemons must not inherit per-session attach/trace env, otherwise they may consume and delete
    // attach files that are intended for the session runner process.
    expect(Object.prototype.hasOwnProperty.call(out, 'HAPPIER_SESSION_ATTACH_FILE')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'HAPPIER_STACK_TOOL_TRACE_FILE')).toBe(false);
  });
});

