import { describe, expect, it } from 'vitest';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';

describe('buildSpawnChildProcessEnv', () => {
  it('merges process env with extra env and strips nested daemon/session bootstrap variables', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'parent',
        HAPPIER_SESSION_AUTOSTART_DAEMON: '1',
      },
      extraEnv: { CUSTOM: 'x' },
    });

    expect(env.PATH).toBe('/bin');
    expect(env.CUSTOM).toBe('x');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBeUndefined();
  });

  it('preserves inherited provider auth/config env and still lets explicit session env override it', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        CLAUDE_CONFIG_DIR: '/Users/test/.claude',
        CLAUDE_CODE_OAUTH_TOKEN: 'stale-claude-token',
        CLAUDE_CODE_SETUP_TOKEN: 'stale-claude-setup-token',
        CODEX_HOME: '/Users/test/.codex',
        OPENAI_API_KEY: 'stale-openai-key',
        OPENCODE_CONFIG_CONTENT: '{"model":"stale-host-model"}',
      },
      extraEnv: {
        CLAUDE_CONFIG_DIR: '/tmp/explicit-claude-config',
        OPENAI_API_KEY: 'explicit-openai-key',
        OPENCODE_CONFIG_CONTENT: '{"model":"explicit-session-model"}',
      },
    });

    expect(env.PATH).toBe('/bin');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/explicit-claude-config');
    expect(env.OPENAI_API_KEY).toBe('explicit-openai-key');
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"explicit-session-model"}');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('stale-claude-token');
    expect(env.CLAUDE_CODE_SETUP_TOKEN).toBe('stale-claude-setup-token');
    expect(env.CODEX_HOME).toBe('/Users/test/.codex');
  });

  it('enables cgroup self-migration for child runners spawned by a background-service daemon', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
      },
      extraEnv: {},
    });

    expect(env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).toBe('1');
  });

  it('does not enable cgroup self-migration for child runners spawned outside a background-service daemon', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
      },
      extraEnv: {},
    });

    expect(env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).toBeUndefined();
  });
});
