import { describe, expect, it } from 'vitest';

import { sanitizeDaemonEnvForSpawn } from './daemon';

describe('sanitizeDaemonEnvForSpawn', () => {
  it('removes tmux client/session variables while preserving unrelated env', () => {
    const out = sanitizeDaemonEnvForSpawn({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      TMUX: '/tmp/tmux-1000/default,123,0',
      TMUX_PANE: '%42',
      TMUX_TMPDIR: '/tmp/custom-tmux',
      HAPPIER_HOME_DIR: '/tmp/happier',
    });

    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/tmp/home');
    expect(out.HAPPIER_HOME_DIR).toBe('/tmp/happier');

    expect(Object.prototype.hasOwnProperty.call(out, 'TMUX')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'TMUX_PANE')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'TMUX_TMPDIR')).toBe(false);
  });
});
