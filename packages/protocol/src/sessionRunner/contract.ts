import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const SESSION_RUNNER_RUNTIME_STATE_FIELD_ID = 'runtime.sessionRunner' as const;

const SessionRunnerSessionIdV1Schema = lazySchema(() => z.string().trim().min(1));
const SessionRunnerIdentityV1Schema = lazySchema(() => z.string().trim().min(1));
const SessionRunnerPidV1Schema = lazySchema(() => z.number().int().positive());
const SessionRunnerTimestampMsV1Schema = lazySchema(() => z.number().int().nonnegative());
const SessionRunnerDiagnosticsV1Schema = lazySchema(() => z.record(z.string().trim().min(1), z.unknown()));
const NullableIdentityFieldV1Schema = lazySchema(() => SessionRunnerIdentityV1Schema.nullable().optional());

export const SESSION_RUNNER_RESTART_MODES_V1 = [
  'if_stale',
  'force_current_cli',
] as const;
export const SessionRunnerRestartModeV1Schema = lazySchema(() => z.enum(SESSION_RUNNER_RESTART_MODES_V1));
export type SessionRunnerRestartModeV1 = z.infer<typeof SessionRunnerRestartModeV1Schema>;

export const SESSION_RUNNER_RESTART_REASONS_V1 = [
  'ui_stale_runner_banner',
  'daemon_restart_session_runners',
  'daemon_restart_session_runners_command',
  'self_update_interactive_prompt',
  'doctor_repair',
  'restart_session_runners_on_update_config',
  'daemon_dist_generation_rollout',
] as const;
export const SessionRunnerRestartReasonV1Schema = lazySchema(() => z.enum(SESSION_RUNNER_RESTART_REASONS_V1));
export type SessionRunnerRestartReasonV1 = z.infer<typeof SessionRunnerRestartReasonV1Schema>;

export const SESSION_RUNNER_RESTART_DISABLED_REASONS = [
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
  'non_destructive_refresh_unsupported',
  'windows_hosted_runner',
  'restart_already_running',
  'current_entrypoint_unknown',
  'runner_entrypoint_unknown',
  'runner_generation_unattested',
  'unsupported_daemon_version',
] as const;
export const SessionRunnerRestartDisabledReasonSchema = lazySchema(() => z.enum(SESSION_RUNNER_RESTART_DISABLED_REASONS));
export type SessionRunnerRestartDisabledReason = z.infer<typeof SessionRunnerRestartDisabledReasonSchema>;

export const SESSION_RUNNER_RESTART_STATUSES_V1 = [
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
export const RestartSessionRunnerStatusV1Schema = lazySchema(() => z.enum(SESSION_RUNNER_RESTART_STATUSES_V1));
export type RestartSessionRunnerStatusV1 = z.infer<typeof RestartSessionRunnerStatusV1Schema>;

export const RestartSessionRunnerRequestV1Schema = lazySchema(() => z
  .object({
    sessionId: SessionRunnerSessionIdV1Schema,
    mode: SessionRunnerRestartModeV1Schema.optional(),
    dryRun: z.boolean().optional(),
    reason: SessionRunnerRestartReasonV1Schema,
    expectedRunnerPid: SessionRunnerPidV1Schema.nullable().optional(),
    expectedProcessCommandHash: NullableIdentityFieldV1Schema,
    expectedRunnerEntrypointIdentity: NullableIdentityFieldV1Schema,
  })
  .strict());
export type RestartSessionRunnerRequestV1 = z.infer<typeof RestartSessionRunnerRequestV1Schema>;

export const RestartAllSessionRunnersRequestV1Schema = lazySchema(() => z
  .object({
    mode: SessionRunnerRestartModeV1Schema,
    dryRun: z.boolean().optional(),
    reason: SessionRunnerRestartReasonV1Schema,
  })
  .strict());
export type RestartAllSessionRunnersRequestV1 = z.infer<typeof RestartAllSessionRunnersRequestV1Schema>;

const RestartSessionRunnerEndpointSummaryV1Schema = lazySchema(() => z
  .object({
    pid: SessionRunnerPidV1Schema.nullable().optional(),
    cliVersion: NullableIdentityFieldV1Schema,
    entrypointVersion: NullableIdentityFieldV1Schema,
    processCommandHash: NullableIdentityFieldV1Schema,
  })
  .strict());

export const RestartSessionRunnerResultV1Schema = lazySchema(() => z
  .object({
    ok: z.boolean(),
    status: RestartSessionRunnerStatusV1Schema,
    sessionId: SessionRunnerSessionIdV1Schema,
    previous: RestartSessionRunnerEndpointSummaryV1Schema.optional(),
    next: RestartSessionRunnerEndpointSummaryV1Schema.optional(),
    reasonCode: SessionRunnerRestartDisabledReasonSchema.nullable().optional(),
    diagnostics: SessionRunnerDiagnosticsV1Schema.optional(),
  })
  .strict());
export type RestartSessionRunnerResultV1 = z.infer<typeof RestartSessionRunnerResultV1Schema>;

export const RestartAllSessionRunnersResultV1Schema = lazySchema(() => z
  .object({
    ok: z.boolean(),
    mode: SessionRunnerRestartModeV1Schema,
    requestedCount: z.number().int().nonnegative(),
    restartedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    results: z.array(RestartSessionRunnerResultV1Schema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.requestedCount !== value.results.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedCount'],
        message: 'requestedCount must match results length',
      });
    }
    if (value.restartedCount + value.skippedCount + value.failedCount !== value.requestedCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedCount'],
        message: 'restart result counts must sum to requestedCount',
      });
    }
  }));
export type RestartAllSessionRunnersResultV1 = z.infer<typeof RestartAllSessionRunnersResultV1Schema>;

export const SessionRunnerEntrypointSourceV1Schema = lazySchema(() => z.enum([
  'structured_state',
  'process_command',
  'launch_spec',
  'unknown',
]));
export type SessionRunnerEntrypointSourceV1 = z.infer<typeof SessionRunnerEntrypointSourceV1Schema>;

export const SessionRunnerDaemonEntrypointSourceV1Schema = lazySchema(() => z.enum([
  'launch_spec',
  'packaged_runtime',
  'override',
  'unknown',
]));
export type SessionRunnerDaemonEntrypointSourceV1 =
  z.infer<typeof SessionRunnerDaemonEntrypointSourceV1Schema>;

export const SessionRunnerStartedByV1Schema = lazySchema(() => z.enum(['daemon', 'local', 'unknown']));
export type SessionRunnerStartedByV1 = z.infer<typeof SessionRunnerStartedByV1Schema>;

export const SessionRunnerStartingModeV1Schema = lazySchema(() => z.enum(['remote', 'local', 'unknown']));
export type SessionRunnerStartingModeV1 = z.infer<typeof SessionRunnerStartingModeV1Schema>;

export const SessionRunnerVersionStateV1Schema = lazySchema(() => z.enum(['current', 'stale', 'unknown']));
export type SessionRunnerVersionStateV1 = z.infer<typeof SessionRunnerVersionStateV1Schema>;

export const SessionRunnerRuntimeStatusSourceV1Schema = lazySchema(() => z.enum([
  'daemon_tracking',
  'runner_marker',
  'runner_report',
  'process_command_inferred',
  'unknown',
]));
export type SessionRunnerRuntimeStatusSourceV1 = z.infer<typeof SessionRunnerRuntimeStatusSourceV1Schema>;

const SessionRunnerRuntimeRunnerV1Schema = lazySchema(() => z
  .object({
    pid: SessionRunnerPidV1Schema.nullable().optional(),
    runtimeId: NullableIdentityFieldV1Schema,
    cliVersion: NullableIdentityFieldV1Schema,
    entrypointVersion: NullableIdentityFieldV1Schema,
    processCommandHash: NullableIdentityFieldV1Schema,
    entrypointSource: SessionRunnerEntrypointSourceV1Schema,
    startedBy: SessionRunnerStartedByV1Schema,
    startingMode: SessionRunnerStartingModeV1Schema,
  })
  .strict());

const SessionRunnerRuntimeDaemonV1Schema = lazySchema(() => z
  .object({
    cliVersion: NullableIdentityFieldV1Schema,
    startedWithCliVersion: NullableIdentityFieldV1Schema,
    currentEntrypointVersion: NullableIdentityFieldV1Schema,
    currentEntrypointSource: SessionRunnerDaemonEntrypointSourceV1Schema,
  })
  .strict());

const SessionRunnerPlannedRestartStateV1Schema = lazySchema(() => z
  .object({
    supported: z.boolean(),
    eligible: z.boolean(),
    disabledReason: SessionRunnerRestartDisabledReasonSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.eligible && !value.supported) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eligible'],
        message: 'eligible planned restart requires supported planned restart',
      });
    }
  }));

export const SessionRunnerRuntimeStateV1Schema = lazySchema(() => z
  .object({
    v: z.literal(1),
    sessionId: SessionRunnerSessionIdV1Schema,
    machineId: NullableIdentityFieldV1Schema,
    daemonId: NullableIdentityFieldV1Schema,
    observedAtMs: SessionRunnerTimestampMsV1Schema,
    runner: SessionRunnerRuntimeRunnerV1Schema,
    daemon: SessionRunnerRuntimeDaemonV1Schema,
    versionState: SessionRunnerVersionStateV1Schema,
    statusSource: SessionRunnerRuntimeStatusSourceV1Schema,
    plannedRestart: SessionRunnerPlannedRestartStateV1Schema,
  })
  .strict());
export type SessionRunnerRuntimeStateV1 = z.infer<typeof SessionRunnerRuntimeStateV1Schema>;

export const SessionRunnerStatusGetRequestV1Schema = lazySchema(() => z
  .object({
    sessionId: SessionRunnerSessionIdV1Schema,
  })
  .strict());
export type SessionRunnerStatusGetRequestV1 = z.infer<typeof SessionRunnerStatusGetRequestV1Schema>;
