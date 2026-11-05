import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { MachineResourcesPolicyV1Schema, type MachineResourcesPolicyGetResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

import { buildSpawnChildProcessEnv } from './buildSpawnChildProcessEnv';
import { parseProcessOwnerTag } from '@/processes/ownerTag';

describe('buildSpawnChildProcessEnv', () => {
  it('inherits the admitted tool idle policy while preserving explicit environment choices', () => {
    const ready = (toolIdleCloseMs?: number | null): MachineResourcesPolicyGetResultV1 => ({ status: 'ready', revision: 1,
      source: 'stored', policy: MachineResourcesPolicyV1Schema.parse({ v: 1,
        ...(toolIdleCloseMs !== undefined ? { processes: { toolIdleCloseMs } } : {}) }) });
    const build = (policy: MachineResourcesPolicyGetResultV1, processEnv: NodeJS.ProcessEnv = {},
      extraEnv: Record<string, string | undefined> = {}, unsetEnvKeys?: readonly string[]) =>
      buildSpawnChildProcessEnv({ processEnv, extraEnv, unsetEnvKeys, readMachineResourcesPolicy: () => policy });
    expect(build(ready()).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe('300000');
    expect(build(ready(1_250)).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe('1250');
    expect(build(ready(null)).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBeUndefined();
    expect(build({ status: 'unavailable' }).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBeUndefined();
    expect(build(ready(), { AGENT_BROWSER_IDLE_TIMEOUT_MS: 'daemon-value' }).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe('daemon-value');
    expect(build(ready(), {}, { AGENT_BROWSER_IDLE_TIMEOUT_MS: '' }).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe('');
    expect(build(ready(), {}, {}, ['AGENT_BROWSER_IDLE_TIMEOUT_MS']).AGENT_BROWSER_IDLE_TIMEOUT_MS).toBeUndefined();
  });
  it('retains host-issued session ownership despite plugin overlays or an explicit unset', () => {
    const env = buildSpawnChildProcessEnv({ processEnv: { HAPPIER_PROCESS_OWNER: 'ambient' },
      extraEnv: { HAPPIER_PROCESS_OWNER: 'forged' }, unsetEnvKeys: ['HAPPIER_PROCESS_OWNER'],
      processOwner: { kind: 'session', sessionId: 'canonical-session' }, happierHomeDir: '/home/alice/.happier' });
    expect(parseProcessOwnerTag(env.HAPPIER_PROCESS_OWNER)?.owner).toEqual({ kind: 'session', sessionId: 'canonical-session' });
  });
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
        HAPPIER_DAEMON_SERVICE_MANAGED_BY: 'desktop',
        HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'dev.happier.app',
      },
      extraEnv: {},
    });

    expect(env.HAPPIER_DAEMON_SERVICE_MANAGED_BY).toBeUndefined();
    expect(env.HAPPIER_DAEMON_SERVICE_BUNDLE_ID).toBeUndefined();
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

  it('removes inherited conditional session controls', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_SESSION_ATTACH_FILE: '/tmp/ambient-attach.json',
        HAPPIER_STACK_PROCESS_KIND: 'infra',
      },
      extraEnv: {},
    });

    expect(env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
    expect(env.HAPPIER_STACK_PROCESS_KIND).toBeUndefined();
  });

  it('keeps API Tokens and CLI continuation handoffs out of generic agent children', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_TOKEN: 'hap_v1_ambient_token_secret',
        HAPPIER_CLI_API_TOKEN_HANDOFF_V1: 'hap_v1_handoff_token_secret',
      },
      extraEnv: {
        HAPPIER_TOKEN: 'hap_v1_profile_token_secret',
        HAPPIER_CLI_API_TOKEN_HANDOFF_V1: 'hap_v1_profile_handoff_secret',
      },
    });

    expect(env.HAPPIER_TOKEN).toBeUndefined();
    expect(env.HAPPIER_CLI_API_TOKEN_HANDOFF_V1).toBeUndefined();
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

  it('marks stack runners as session processes without forwarding daemon Stack configuration', () => {
    const env = buildSpawnChildProcessEnv({
      processEnv: {
        PATH: '/bin',
        HAPPIER_STACK_STACK: 'repo-dev',
        HAPPIER_STACK_ENV_FILE: '/tmp/repo-dev/env',
        HAPPIER_STACK_PROCESS_KIND: 'infra',
        HAPPIER_STACK_REPO_DIR: '/work/daemon-checkout',
        HAPPIER_STACK_HOME_DIR: '/work/stack-home',
      },
      extraEnv: { HAPPIER_HOME_DIR: '/work/session-home', HAPPIER_STACK_STORAGE_DIR: '/work/stack-storage' },
    });

    const observed = JSON.parse(execFileSync(process.execPath, ['-e', `
      process.stdout.write(JSON.stringify({
        stackEnvironment: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('HAPPIER_STACK_'))),
        sessionHome: process.env.HAPPIER_HOME_DIR,
      }));
    `], { env, encoding: 'utf8' }));
    expect(observed).toEqual({
      stackEnvironment: { HAPPIER_STACK_PROCESS_KIND: 'session' },
      sessionHome: '/work/session-home',
    });
  });
});
