import { describe, expect, it } from 'vitest';

import { HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY } from '@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration';
import { resolveFileLogLevel } from '@/ui/logFileLevel';
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

  it('injects the daemon active server selection for spawned child runners', () => {
    const params = {
      processEnv: {
        PATH: '/bin',
        HAPPIER_ACTIVE_SERVER_ID: 'stale-server',
        HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'stack_repo-remote-dev-d72117acdb__id_default',
        HAPPIER_SERVER_URL: 'https://stale.example.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:4999',
        HAPPIER_PUBLIC_SERVER_URL: 'https://stale-public.example.test',
        HAPPIER_WEBAPP_URL: 'https://stale-app.example.test',
      },
      extraEnv: {},
      serverSelectionEnv: {
        activeServerId: 'stack-a',
        canonicalServerUrl: 'http://127.0.0.1:13155',
        apiServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://127.0.0.1:13155',
      },
    };
    const env = buildSpawnChildProcessEnv(params);

    expect(env.PATH).toBe('/bin');
    expect(env.HAPPIER_ACTIVE_SERVER_ID).toBe('stack-a');
    expect(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID).toBe(
      'stack_repo-remote-dev-d72117acdb__id_default',
    );
    expect(env.HAPPIER_SERVER_URL).toBe('http://127.0.0.1:3005');
    expect(env.HAPPIER_LOCAL_SERVER_URL).toBe('http://127.0.0.1:3005');
    expect(env.HAPPIER_PUBLIC_SERVER_URL).toBe('http://127.0.0.1:13155');
    expect(env.HAPPIER_WEBAPP_URL).toBe('http://127.0.0.1:13155');
  });

  it('promotes an old stack daemon active scope into the child lifecycle scope', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_ACTIVE_SERVER_ID: 'stack_repo-remote-dev-d72117acdb__id_default',
      },
      extraEnv: {},
      serverSelectionEnv: {
        activeServerId: 'stack_repo-remote-dev-d72117acdb__id_default',
        canonicalServerUrl: 'http://127.0.0.1:52753',
        apiServerUrl: 'http://127.0.0.1:52753',
        webappUrl: 'http://localhost:52753',
      },
    });

    expect(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID).toBe(
      'stack_repo-remote-dev-d72117acdb__id_default',
    );
  });

  it('enables self-migration for child runners spawned by a background-service daemon', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
      },
      extraEnv: {},
    });

    expect(env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY]).toBe('1');
  });

  it('keeps self-migration enabled across an authorized daemon self-restart', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
      },
      extraEnv: {},
    });

    expect(env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY]).toBe('1');
  });

  it('does not enable self-migration for child runners spawned outside a background-service daemon', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_DAEMON_STARTUP_SOURCE: 'manual',
      },
      extraEnv: {},
    });

    expect(env[HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY]).toBeUndefined();
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

  it('strips obsolete daemon-generation authority from parent and session overrides', () => {
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

  it('does not force debug file logging for prod-shaped daemon-spawned runners', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: { PATH: '/bin' },
      extraEnv: {},
    });

    expect(env.HAPPIER_LOG_LEVEL).toBeUndefined();
    expect(resolveFileLogLevel({ env, isDaemonProcess: false })).toBe('info');
  });

  it('defaults stack daemon-spawned runners to debug file logging so headless stack runners leave forensics logs (RC-RESUMEFLAP)', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_STACK_ENV_FILE: '/tmp/repo-remote-dev/env',
        HAPPIER_STACK_PROCESS_KIND: 'infra',
      },
      extraEnv: {},
    });

    expect(env.HAPPIER_LOG_LEVEL).toBe('debug');
  });

  it('honors an explicit file log level override instead of forcing debug on daemon children or stack children', () => {
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

    const stackExplicit = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_STACK_ENV_FILE: '/tmp/repo-remote-dev/env',
        HAPPIER_LOG_LEVEL: 'info',
      },
      extraEnv: {},
    });
    expect(stackExplicit.HAPPIER_LOG_LEVEL).toBe('info');
  });

  it('marks daemon-spawned stack child runners as session processes', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_STACK_STACK: 'repo-remote-dev',
        HAPPIER_STACK_ENV_FILE: '/tmp/repo-remote-dev/env',
        HAPPIER_STACK_PROCESS_KIND: 'infra',
      },
      extraEnv: {},
    });

    expect(env.HAPPIER_STACK_STACK).toBe('repo-remote-dev');
    expect(env.HAPPIER_STACK_ENV_FILE).toBe('/tmp/repo-remote-dev/env');
    expect(env.HAPPIER_STACK_PROCESS_KIND).toBe('session');
  });
});
