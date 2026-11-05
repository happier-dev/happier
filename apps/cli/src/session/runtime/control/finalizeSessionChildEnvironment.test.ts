import { describe, expect, it } from 'vitest';

import { finalizeSessionChildEnvironment } from './finalizeSessionChildEnvironment';

describe('finalizeSessionChildEnvironment', () => {
  it.each(['session', null] as const)('strips Stack configuration before %s children while retaining session diagnostics', (stackProcessKind) => {
    const environment = {
      PATH: '/bin',
      HAPPIER_STACK_REPO_DIR: '/work/daemon-checkout',
      HAPPIER_STACK_HOME_DIR: '/work/stack-home',
      HAPPIER_STACK_STACK: 'daemon-stack',
      HAPPIER_STACK_ENV_FILE: '/work/daemon-stack/env',
      HAPPIER_STACK_FUTURE_INTERNAL: 'internal',
      happier_stack_workspace_dir: '/work/workspace',
      HAPPIER_STACK_PROCESS_KIND: 'infra',
      HAPPIER_STACK_RESCUE: '1',
      HAPPIER_STACK_TOOL_TRACE: '1',
      HAPPIER_STACK_TOOL_TRACE_DIR: '/work/traces',
      HAPPIER_STACK_TOOL_TRACE_FILE: '/work/traces/session.jsonl',
    };
    const output = finalizeSessionChildEnvironment({
      environment,
      explicitEnvironment: environment,
      enableCgroupSelfMigration: false,
      stackProcessKind,
    });

    expect(output).toEqual({
      PATH: '/bin',
      HAPPIER_STACK_RESCUE: '1',
      HAPPIER_STACK_TOOL_TRACE: '1',
      HAPPIER_STACK_TOOL_TRACE_DIR: '/work/traces',
      HAPPIER_STACK_TOOL_TRACE_FILE: '/work/traces/session.jsonl',
      ...(stackProcessKind ? { HAPPIER_STACK_PROCESS_KIND: stackProcessKind, HAPPIER_LOG_LEVEL: 'debug' } : {}),
    });
    expect(environment.HAPPIER_STACK_REPO_DIR).toBe('/work/daemon-checkout');
  });

  it('preserves an explicit provider entrypoint while stripping inherited detection and session controls', () => {
    const environment = {
      CLAUDE_CODE_ENTRYPOINT: 'happier', CLAUDECODE: '1', HERDR_ENV: '1',
      HAPPIER_SESSION_ATTACH_FILE: '/tmp/spoofed-attach',
    };
    const output = finalizeSessionChildEnvironment({
      environment,
      explicitEnvironment: environment,
      enableCgroupSelfMigration: false,
      stackProcessKind: null,
    });
    expect(output.CLAUDE_CODE_ENTRYPOINT).toBe('happier');
    expect(output.CLAUDECODE).toBeUndefined();
    expect(output.HERDR_ENV).toBeUndefined();
    expect(output.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
    expect(environment.CLAUDECODE).toBe('1');
    expect(finalizeSessionChildEnvironment({
      environment,
      enableCgroupSelfMigration: false,
      stackProcessKind: null,
    }).CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it('keeps host process ownership on agent and MCP children', () => {
    const tag = 'v1.0123456789ab.session.session-1';
    expect(finalizeSessionChildEnvironment({ environment: { HAPPIER_PROCESS_OWNER: tag },
      enableCgroupSelfMigration: false, stackProcessKind: null }).HAPPIER_PROCESS_OWNER).toBe(tag);
  });
  it('removes ambient session controls and restores only trusted canonical values', () => {
    const env = finalizeSessionChildEnvironment({
      environment: {
        PATH: '/bin',
        SAFE_VALUE: 'kept',
        HAPPIER_DAEMON_SERVICE_BUNDLE_ID: 'dev.happier.app',
        HAPPIER_DAEMON_SERVICE_AUTOSTART: 'at-login',
        HAPPIER_SESSION_PROFILE_ID: 'ambient-profile',
        HAPPIER_SESSION_ATTACH_FILE: '/tmp/ambient-attach.json',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'ambient-selections',
        HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE:
          '/tmp/ambient-runner-bootstrap.json',
        HAPPIER_STACK_PROCESS_KIND: 'plugin-spoof',
        TMUX_SESSION_NAME: 'ambient-tmux',
      },
      canonicalSessionControlEnvironment: {
        HAPPIER_SESSION_PROFILE_ID: 'canonical-profile',
        HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'canonical-selections',
        HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE:
          '/tmp/canonical-runner-bootstrap.json',
      },
      enableCgroupSelfMigration: false,
      stackProcessKind: 'session',
    });

    expect(env).toMatchObject({
      PATH: '/bin',
      SAFE_VALUE: 'kept',
      HAPPIER_SESSION_PROFILE_ID: 'canonical-profile',
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'canonical-selections',
      HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE:
        '/tmp/canonical-runner-bootstrap.json',
      HAPPIER_STACK_PROCESS_KIND: 'session',
    });
    expect(env.HAPPIER_SESSION_ATTACH_FILE).toBeUndefined();
    expect(env.TMUX_SESSION_NAME).toBeUndefined();
    expect(env.HAPPIER_DAEMON_SERVICE_BUNDLE_ID).toBeUndefined();
    expect(env.HAPPIER_DAEMON_SERVICE_AUTOSTART).toBeUndefined();
  });

  it('rejects non-control values in the trusted control channel', () => {
    expect(() => finalizeSessionChildEnvironment({
      environment: { PATH: '/bin' },
      canonicalSessionControlEnvironment: { OPENAI_API_KEY: 'must-not-pass' },
      enableCgroupSelfMigration: false,
      stackProcessKind: null,
    })).toThrow(/session-control environment key/u);

    expect(() => finalizeSessionChildEnvironment({
      environment: { PATH: '/bin' },
      canonicalSessionControlEnvironment: { happier_session_profile_id: 'wrong-case' },
      enableCgroupSelfMigration: false,
      stackProcessKind: null,
    })).toThrow(/session-control environment key/u);
  });
});
