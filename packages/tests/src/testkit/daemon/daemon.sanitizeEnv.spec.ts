import { describe, expect, it } from 'vitest';

import { sanitizeDaemonEnvForSpawn } from './daemon';

describe('sanitizeDaemonEnvForSpawn', () => {
  it('preserves explicit isolated runtime inputs while stripping inherited stack and daemon authority', () => {
    const env = sanitizeDaemonEnvForSpawn({
      PATH: '/usr/bin',
      HAPPIER_HOME_DIR: '/tmp/isolated-home',
      HAPPIER_SERVER_URL: 'http://127.0.0.1:30123',
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:30124',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: '/tmp/isolated-cli/dist/index.mjs',
      HAPPIER_SESSION_ATTACH_FILE: '/tmp/attach.json',
      HAPPIER_STACK_TOOL_TRACE_FILE: '/tmp/trace.json',
      HAPPIER_STACK_STACK: 'inherited-stack',
      HAPPIER_STACK_ENV_FILE: '/tmp/inherited-stack.env',
      HAPPIER_STACK_CLI_HOME_DIR: '/tmp/inherited-home',
      HAPPIER_STACK_SERVER_PORT: '49999',
      HAPPY_STACK_STACK: 'legacy-inherited-stack',
      HAPPIER_ACTIVE_SERVER_ID: 'srv_remote',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_inherited-stack',
      HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'daemon-123',
      HAPPIER_DAEMON_SERVICE_SERVER_URL: 'https://remote.example.test',
      TMUX: 'tmux-123',
    });

    expect(env.HAPPIER_DISABLE_CAFFEINATE).toBe('1');
    expect(env.HAPPIER_DAEMON_SESSION_RESPAWN_ENABLED).toBe('0');
    expect(env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
    expect(env.HAPPIER_STACK_TOOL_TRACE_FILE).toBeUndefined();
    expect(env.HAPPIER_STACK_STACK).toBeUndefined();
    expect(env.HAPPIER_STACK_ENV_FILE).toBeUndefined();
    expect(env.HAPPIER_STACK_CLI_HOME_DIR).toBeUndefined();
    expect(env.HAPPIER_STACK_SERVER_PORT).toBeUndefined();
    expect(env.HAPPY_STACK_STACK).toBeUndefined();
    expect(env.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
    expect(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID).toBeUndefined();
    expect(env.HAPPIER_DAEMON_SERVICE_INSTANCE_ID).toBeUndefined();
    expect(env.HAPPIER_DAEMON_SERVICE_SERVER_URL).toBeUndefined();
    expect(env.TMUX).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HAPPIER_HOME_DIR).toBe('/tmp/isolated-home');
    expect(env.HAPPIER_SERVER_URL).toBe('http://127.0.0.1:30123');
    expect(env.HAPPIER_WEBAPP_URL).toBe('http://127.0.0.1:30124');
    expect(env.HAPPIER_VARIANT).toBe('dev');
    expect(env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT).toBe('/tmp/isolated-cli/dist/index.mjs');
  });
});
