import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

type SafeParseSchema<T = unknown> = Readonly<{
  safeParse: (value: unknown) => { success: boolean; data?: T };
  parse: (value: unknown) => T;
}>;

function protocolSchema<T = unknown>(name: string): SafeParseSchema<T> {
  const candidate = (protocol as Record<string, unknown>)[name];
  expect(candidate).toBeTruthy();
  expect(typeof (candidate as { safeParse?: unknown }).safeParse).toBe('function');
  expect(typeof (candidate as { parse?: unknown }).parse).toBe('function');
  return candidate as SafeParseSchema<T>;
}

function protocolExport<T = unknown>(name: string): T {
  const candidate = (protocol as Record<string, unknown>)[name];
  expect(candidate).toBeDefined();
  return candidate as T;
}

const restartReasons = [
  'ui_stale_runner_banner',
  'daemon_restart_session_runners',
  'daemon_restart_session_runners_command',
  'self_update_interactive_prompt',
  'doctor_repair',
  'restart_session_runners_on_update_config',
] as const;

const restartStatuses = [
  'restarted',
  'already_current',
  'dry_run_restartable',
  'not_found',
  'not_tracked',
  'not_daemon_started',
  'runner_not_active',
  'version_unknown',
  'runner_identity_changed',
  'busy',
  'missing_resume_snapshot',
  'missing_spawn_options',
  'unsupported_daemon',
  'ineligible',
  'stop_failed',
  'spawn_failed',
  'partial_failure',
] as const;

const disabledReasons = [
  'not_daemon_started',
  'not_remote_started',
  'not_active',
  'no_tracked_process',
  'missing_resume_identity',
  'missing_spawn_options',
  'missing_credentials',
  'unsupported_backend',
  'turn_in_progress',
  'approval_pending',
  'terminal_detached',
  'terminal_host_attached',
  'windows_hosted_runner',
  'restart_already_running',
  'current_entrypoint_unknown',
  'runner_entrypoint_unknown',
  'runner_generation_unattested',
  'unsupported_daemon_version',
] as const;

describe('session runner control contract', () => {
  it('exports the session runner runtime state field id and RPC methods', () => {
    expect(protocolExport('SESSION_RUNNER_RUNTIME_STATE_FIELD_ID')).toBe('runtime.sessionRunner');
    expect(protocolExport('SESSION_RUNNER_RUNTIME_METADATA_KEY')).toBe('sessionRunnerRuntimeV1');
    expect(protocol.RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET).toBe('daemon.sessionRunner.status.get');
    expect(protocol.RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART).toBe('daemon.sessionRunner.restart');
    expect(protocol.RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL).toBe('daemon.sessionRunner.restartAll');
  });

  it('accepts valid planned restart requests', () => {
    const schema = protocolSchema('RestartSessionRunnerRequestV1Schema');

    for (const reason of restartReasons) {
      expect(schema.safeParse({
        sessionId: 'sess_123',
        mode: 'if_stale',
        dryRun: true,
        reason,
        expectedRunnerPid: 123,
        expectedProcessCommandHash: 'cmd_hash_1',
        expectedRunnerEntrypointIdentity: 'happier-cli:1.2.3',
      }).success).toBe(true);
    }

    expect(schema.parse({
      sessionId: ' sess_with_spaces ',
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners_command',
    })).toMatchObject({
      sessionId: 'sess_with_spaces',
      mode: 'force_current_cli',
    });
  });

  it('rejects malformed planned restart requests', () => {
    const schema = protocolSchema('RestartSessionRunnerRequestV1Schema');

    expect(schema.safeParse({ reason: 'ui_stale_runner_banner' }).success).toBe(false);
    expect(schema.safeParse({ sessionId: '', reason: 'ui_stale_runner_banner' }).success).toBe(false);
    expect(schema.safeParse({ sessionId: '   ', reason: 'ui_stale_runner_banner' }).success).toBe(false);
    expect(schema.safeParse({ sessionId: 'sess_123', reason: 'unknown_reason' }).success).toBe(false);
    expect(schema.safeParse({ sessionId: 'sess_123', mode: 'replace', reason: 'doctor_repair' }).success).toBe(false);
    expect(schema.safeParse({
      sessionId: 'sess_123',
      reason: 'doctor_repair',
      expectedRunnerPid: -1,
    }).success).toBe(false);
  });

  it('exports restart-all and status-get request schemas', () => {
    const restartAllSchema = protocolSchema('RestartAllSessionRunnersRequestV1Schema');
    expect(restartAllSchema.parse({
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners',
      dryRun: true,
    })).toEqual({
      mode: 'force_current_cli',
      reason: 'daemon_restart_session_runners',
      dryRun: true,
    });
    expect(restartAllSchema.safeParse({
      mode: 'replace',
      reason: 'daemon_restart_session_runners',
    }).success).toBe(false);

    const statusGetSchema = protocolSchema('SessionRunnerStatusGetRequestV1Schema');
    expect(statusGetSchema.parse({ sessionId: ' sess_123 ' })).toEqual({ sessionId: 'sess_123' });
    expect(statusGetSchema.safeParse({ sessionId: '' }).success).toBe(false);
  });

  it('exports and validates disabled reasons', () => {
    const schema = protocolSchema('SessionRunnerRestartDisabledReasonSchema');
    const exportedReasons = protocolExport<readonly string[]>('SESSION_RUNNER_RESTART_DISABLED_REASONS');

    expect(exportedReasons).toEqual(disabledReasons);
    for (const reason of disabledReasons) {
      expect(schema.safeParse(reason).success).toBe(true);
    }
    expect(schema.safeParse('raw_path_hidden').success).toBe(false);
  });

  it('accepts every planned restart result status', () => {
    const schema = protocolSchema('RestartSessionRunnerResultV1Schema');
    const exportedStatuses = protocolExport<readonly string[]>('SESSION_RUNNER_RESTART_STATUSES_V1');

    expect(exportedStatuses).toEqual(restartStatuses);
    for (const status of restartStatuses) {
      const ok = status === 'restarted' || status === 'already_current' || status === 'dry_run_restartable';
      expect(schema.safeParse({
        ok,
        status,
        sessionId: 'sess_123',
        previous: {
          pid: 123,
          cliVersion: '1.0.0',
          entrypointVersion: '1.0.0',
          processCommandHash: 'old_hash',
        },
        next: ok ? {
          pid: 456,
          cliVersion: '1.1.0',
          entrypointVersion: '1.1.0',
          processCommandHash: 'new_hash',
        } : undefined,
        reasonCode: ok ? null : 'missing_spawn_options',
        diagnostics: { source: 'unit-test', retryable: false },
      }).success).toBe(true);
    }
  });

  it('rejects malformed planned restart results', () => {
    const schema = protocolSchema('RestartSessionRunnerResultV1Schema');

    expect(schema.safeParse({
      ok: true,
      status: 'migrated',
      sessionId: 'sess_123',
    }).success).toBe(false);
    expect(schema.safeParse({
      ok: true,
      status: 'restarted',
      sessionId: '',
    }).success).toBe(false);
    expect(schema.safeParse({
      ok: false,
      status: 'ineligible',
      sessionId: 'sess_123',
      reasonCode: 'unknown_reason',
    }).success).toBe(false);
    expect(schema.safeParse({
      ok: true,
      status: 'restarted',
      sessionId: 'sess_123',
      previous: { executablePath: '/Users/alice/.happier/cli-dev/versions/1.0.0/happier' },
    }).success).toBe(false);
  });

  it('accepts bulk planned restart results with count fields', () => {
    const schema = protocolSchema('RestartAllSessionRunnersResultV1Schema');

    expect(schema.parse({
      ok: false,
      mode: 'force_current_cli',
      requestedCount: 2,
      restartedCount: 1,
      skippedCount: 0,
      failedCount: 1,
      results: [
        { ok: true, status: 'restarted', sessionId: 'sess_1' },
        { ok: false, status: 'spawn_failed', sessionId: 'sess_2', diagnostics: { phase: 'spawn' } },
      ],
    })).toMatchObject({
      mode: 'force_current_cli',
      requestedCount: 2,
      restartedCount: 1,
      failedCount: 1,
    });
  });

  it('validates runtime state shape without exposing raw local paths', () => {
    const schema = protocolSchema('SessionRunnerRuntimeStateV1Schema');

    expect(schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      machineId: 'machine_1',
      daemonId: 'daemon_1',
      observedAtMs: 123,
      runner: {
        pid: 123,
        runtimeId: 'runner-runtime-1',
        cliVersion: '1.0.0',
        entrypointVersion: '1.0.0',
        processCommandHash: 'cmd_hash_1',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: '1.1.0',
        currentEntrypointSource: 'packaged_runtime',
      },
      versionState: 'stale',
      statusSource: 'process_command_inferred',
      plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
      },
    }).success).toBe(true);

    expect(schema.safeParse({
      v: 1,
      sessionId: 'sess_123',
      observedAtMs: 123,
      runner: {
        entrypointSource: 'unknown',
        startedBy: 'unknown',
        startingMode: 'unknown',
        processCommand: '/Users/alice/.happier/cli-dev/versions/1.0.0/happier',
      },
      daemon: {
        currentEntrypointSource: 'unknown',
        currentEntrypointPath: '/Users/alice/.happier/cli-dev/versions/1.1.0/happier',
      },
      versionState: 'unknown',
      statusSource: 'unknown',
      plannedRestart: {
        supported: false,
        eligible: false,
        disabledReason: 'runner_entrypoint_unknown',
      },
    }).success).toBe(false);
  });

  it('allows session-runner runtime state in the canonical session metadata field', () => {
    const metadataKey = protocolExport<string>('SESSION_RUNNER_RUNTIME_METADATA_KEY');
    const schema = protocolSchema('SessionMetadataSchema');
    const runtimeState = protocolSchema('SessionRunnerRuntimeStateV1Schema').parse({
      v: 1,
      sessionId: 'sess_123',
      machineId: 'machine_1',
      daemonId: 'daemon_1',
      observedAtMs: 123,
      runner: {
        pid: 123,
        runtimeId: 'runner-runtime-1',
        cliVersion: '1.0.0',
        entrypointVersion: '1.0.0',
        processCommandHash: 'cmd_hash_1',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
      },
      daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'runner-runtime-2',
        currentEntrypointSource: 'packaged_runtime',
      },
      versionState: 'stale',
      statusSource: 'process_command_inferred',
      plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
      },
    });
    const runtimeStateRecord = runtimeState as Record<string, unknown> & {
      runner: Record<string, unknown>;
    };

    expect(schema.safeParse({ [metadataKey]: runtimeState }).success).toBe(true);
    expect(schema.safeParse({
      [metadataKey]: {
        ...runtimeStateRecord,
        runner: {
          ...runtimeStateRecord.runner,
          executablePath: '/Users/alice/.happier/cli-dev/versions/1.0.0/happier',
        },
      },
    }).success).toBe(false);
  });

  it('fails closed when runtime restart support fields are missing', () => {
    const schema = protocolSchema('SessionRunnerRuntimeStateV1Schema');
    const baseState = {
      v: 1,
      sessionId: 'sess_123',
      observedAtMs: 123,
      runner: {
        entrypointSource: 'unknown',
        startedBy: 'unknown',
        startingMode: 'unknown',
      },
      daemon: {
        currentEntrypointSource: 'unknown',
      },
      versionState: 'unknown',
      statusSource: 'unknown',
    };

    expect(schema.safeParse(baseState).success).toBe(false);
    expect(schema.safeParse({
      ...baseState,
      plannedRestart: { eligible: false, disabledReason: 'unsupported_daemon_version' },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...baseState,
      plannedRestart: { supported: false, disabledReason: 'unsupported_daemon_version' },
    }).success).toBe(false);
  });
});
