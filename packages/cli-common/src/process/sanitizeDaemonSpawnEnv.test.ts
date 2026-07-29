import { describe, expect, it } from 'vitest';

import { sanitizeDaemonSpawnEnv } from './sanitizeDaemonSpawnEnv.js';

describe('sanitizeDaemonSpawnEnv', () => {
  it('strips inherited stack, terminal, session, lifecycle, and service authority', () => {
    expect(sanitizeDaemonSpawnEnv({
      HAPPIER_STACK_STACK: 'leaked',
      HAPPIER_STACK_CUSTOM: 'leaked',
      HAPPY_STACK_CUSTOM: 'leaked',
      TMUX: 'leaked',
      TMUX_PANE: 'leaked',
      TMUX_TMPDIR: 'leaked',
      HAPPIER_SESSION_ATTACH_FILE: 'leaked',
      HAPPY_SESSION_ATTACH_FILE: 'leaked',
      HAPPIER_ACTIVE_SERVER_ID: 'leaked',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'leaked',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'leaked',
      HAPPIER_DAEMON_SERVICE_SERVER_URL: 'leaked',
      HAPPIER_HOME_DIR: '/isolated/home',
      HAPPIER_SERVER_URL: 'https://isolated.example',
    })).toEqual({
      HAPPIER_HOME_DIR: '/isolated/home',
      HAPPIER_SERVER_URL: 'https://isolated.example',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '0',
    });
  });

  it('preserves explicit daemon safety overrides', () => {
    expect(sanitizeDaemonSpawnEnv({
      HAPPIER_DISABLE_CAFFEINATE: '0',
      HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '1',
    })).toEqual({
      HAPPIER_DISABLE_CAFFEINATE: '0',
      HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED: '1',
    });
  });
});
