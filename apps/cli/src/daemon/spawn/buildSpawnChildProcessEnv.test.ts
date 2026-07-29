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

  it('preserves the daemon lifecycle scope in spawned child environments', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
      },
      extraEnv: {
        HAPPIER_ACTIVE_SERVER_ID: 'android-keyboard-qa',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-current__id_default',
      },
    });

    expect(env.HAPPIER_ACTIVE_SERVER_ID).toBe('android-keyboard-qa');
    expect(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID).toBe('stack_repo-current__id_default');
  });

  it('removes explicitly unset inherited keys case-insensitively without turning unset into empty', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        OPENAI_API_KEY: 'ambient-key',
        Gemini_Model: 'ambient-model',
      },
      extraEnv: {
        Gemini_Model: 'explicit-model',
        EMPTY: '',
      },
      unsetEnvKeys: ['openai_api_key', 'GEMINI_MODEL'],
    });

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.Gemini_Model).toBe('explicit-model');
    expect(env.EMPTY).toBe('');
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

  it('does not leak daemon lifecycle ownership env into child runners', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_RUNTIME_ID: 'runtime-parent',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
        HAPPIER_DAEMON_TAKEOVER: '1',
      },
      extraEnv: {},
    });

    expect(env.PATH).toBe('/bin');
    expect(env.HAPPIER_DAEMON_RUNTIME_ID).toBeUndefined();
    expect(env.HAPPIER_DAEMON_STARTUP_SOURCE).toBeUndefined();
    expect(env.HAPPIER_DAEMON_TAKEOVER).toBeUndefined();
  });

  it('strips obsolete daemon-incarnation authority from surviving runners', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_EXECUTION_GENERATION_V1: 'spawning-daemon',
      },
      extraEnv: {
        HAPPIER_DAEMON_EXECUTION_GENERATION_V1: 'untrusted-session-override',
      },
    });

    expect(env.HAPPIER_DAEMON_EXECUTION_GENERATION_V1).toBeUndefined();
  });

  it('removes inherited conditional session controls while preserving daemon-issued values', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_SESSION_ATTACH_FILE: '/tmp/ambient-attach.json',
        HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN: 'ambient-raw-token',
        HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE: '/tmp/ambient-token-file',
        HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE: '/tmp/ambient-agent-runtime-token-file',
        HAPPIER_STACK_PROCESS_KIND: 'infra',
      },
      extraEnv: {
        HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE: '/tmp/daemon-token-file',
        HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE: '/tmp/daemon-agent-runtime-token-file',
      },
    });

    expect(env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
    expect(env.HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN).toBeUndefined();
    expect(env.HAPPIER_PLUGIN_LOCAL_SERVICES_BRIDGE_TOKEN_FILE).toBe('/tmp/daemon-token-file');
    expect(env.HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE)
      .toBe('/tmp/daemon-agent-runtime-token-file');
    expect(env.HAPPIER_STACK_PROCESS_KIND).toBeUndefined();
  });

  it('does not inherit an Agent runtime bridge that the daemon did not issue', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE: '/tmp/ambient-agent-runtime-token-file',
      },
      extraEnv: {},
    });

    expect(env.HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE).toBeUndefined();
  });

  it('does not force debug file logging for prod-shaped daemon-spawned runners', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: { PATH: '/bin' },
      extraEnv: {},
    });

    expect(env.HAPPIER_LOG_LEVEL).toBeUndefined();
  });

  it('defaults stack daemon-spawned runners to debug file logging so headless stack runners leave forensic logs', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: { PATH: '/bin', HAPPIER_STACK_ENV_FILE: '/tmp/stack/env.local' },
      extraEnv: {},
    });

    expect(env.HAPPIER_LOG_LEVEL).toBe('debug');
  });

  it('honors an explicit runner file log level override instead of forcing debug', () => {
    const inherited = buildSpawnChildProcessEnv({
      processEnv: { PATH: '/bin', HAPPIER_LOG_LEVEL: 'silent' },
      extraEnv: {},
    });
    expect(inherited.HAPPIER_LOG_LEVEL).toBe('silent');

    const explicit = buildSpawnChildProcessEnv({
      processEnv: { PATH: '/bin' },
      extraEnv: { HAPPIER_LOG_LEVEL: 'warn' },
    });
    expect(explicit.HAPPIER_LOG_LEVEL).toBe('warn');
  });

  it('marks daemon-spawned stack child runners as session processes', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_STACK_STACK: 'repo-dev',
        HAPPIER_STACK_ENV_FILE: '/tmp/repo-dev/env',
        HAPPIER_STACK_PROCESS_KIND: 'infra',
      },
      extraEnv: {},
    });

    expect(env.HAPPIER_STACK_STACK).toBe('repo-dev');
    expect(env.HAPPIER_STACK_ENV_FILE).toBe('/tmp/repo-dev/env');
    expect(env.HAPPIER_STACK_PROCESS_KIND).toBe('session');
  });
});
