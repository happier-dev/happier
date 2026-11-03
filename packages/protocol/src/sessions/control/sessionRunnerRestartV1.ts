import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { SessionRunnerRuntimeStateV1 } from './sessionRunnerRuntimeV1.js';
import { isMachineRpcTimeoutError, isRpcMethodNotFoundResult, readRpcErrorCode, RPC_ERROR_CODES, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '../../rpc/errors.js';

const SessionRunnerSessionIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SessionRunnerIdentityV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SessionRunnerPidV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));
const SessionRunnerDiagnosticsV1Schema = lazyZodSchema(() => z.record(z.string().check(z.trim(), z.minLength(1)), z.unknown()));
const NullableIdentityFieldV1Schema = lazyZodSchema(() => z.optional(z.nullable(SessionRunnerIdentityV1Schema)));

export const SESSION_RUNNER_RESTART_MODES_V1 = [
  'if_stale',
  'force_current_cli',
] as const;
export const SessionRunnerRestartModeV1Schema = lazyZodSchema(() => z.enum(SESSION_RUNNER_RESTART_MODES_V1));
export type SessionRunnerRestartModeV1 = z.infer<typeof SessionRunnerRestartModeV1Schema>;

export const SESSION_RUNNER_RESTART_REASONS_V1 = [
  'ui_stale_runner_banner',
  'daemon_restart_session_runners',
  'daemon_restart_session_runners_command',
  'self_update_interactive_prompt',
  'doctor_repair',
  'restart_session_runners_on_update_config',
  'daemon_dist_generation_rollout',
  'capability_selection_change',
] as const;
export const SessionRunnerRestartReasonV1Schema = lazyZodSchema(() => z.enum(SESSION_RUNNER_RESTART_REASONS_V1));
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
  'restart_admission_unsupported',
] as const;
export const SessionRunnerRestartDisabledReasonSchema = lazyZodSchema(() => z.enum(SESSION_RUNNER_RESTART_DISABLED_REASONS));
export type SessionRunnerRestartDisabledReason =
  z.infer<typeof SessionRunnerRestartDisabledReasonSchema>;

/** Daemon restart custody belongs only to a daemon-started runner. */
export function readSessionRunnerDaemonLaunchRefusalV1(startedBy: unknown): 'not_daemon_started' | null {
  return startedBy === 'daemon' ? null : 'not_daemon_started';
}

/** Includes the retained legacy `visible` launch spelling at daemon custody. */
export function isSessionRunnerWindowsHostedLaunchV1(launchMode: unknown): boolean {
  return launchMode === 'windows_terminal' || launchMode === 'console' || launchMode === 'visible';
}

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
  'restart_admission_unsupported',
  'ineligible',
  'stop_failed',
  'spawn_failed',
  'partial_failure',
] as const;
export const RestartSessionRunnerStatusV1Schema = lazyZodSchema(() => z.enum(SESSION_RUNNER_RESTART_STATUSES_V1));
export type RestartSessionRunnerStatusV1 = z.infer<typeof RestartSessionRunnerStatusV1Schema>;

export const RestartSessionRunnerRequestV1Schema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionRunnerSessionIdV1Schema,
    mode: z.optional(SessionRunnerRestartModeV1Schema),
    dryRun: z.optional(z.boolean()),
    reason: SessionRunnerRestartReasonV1Schema,
    expectedRunnerPid: z.optional(z.nullable(SessionRunnerPidV1Schema)),
    expectedProcessCommandHash: NullableIdentityFieldV1Schema,
    expectedRunnerEntrypointIdentity: NullableIdentityFieldV1Schema,
  }));
export type RestartSessionRunnerRequestV1 = z.infer<typeof RestartSessionRunnerRequestV1Schema>;

const RestartSessionRunnerEndpointSummaryV1Schema = lazyZodSchema(() => z.strictObject({
    pid: z.optional(z.nullable(SessionRunnerPidV1Schema)),
    cliVersion: NullableIdentityFieldV1Schema,
    entrypointVersion: NullableIdentityFieldV1Schema,
    processCommandHash: NullableIdentityFieldV1Schema,
  }));

export const RestartSessionRunnerResultV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.boolean(),
    status: RestartSessionRunnerStatusV1Schema,
    sessionId: SessionRunnerSessionIdV1Schema,
    previous: z.optional(RestartSessionRunnerEndpointSummaryV1Schema),
    next: z.optional(RestartSessionRunnerEndpointSummaryV1Schema),
    reasonCode: z.optional(z.nullable(SessionRunnerRestartDisabledReasonSchema)),
    diagnostics: z.optional(SessionRunnerDiagnosticsV1Schema),
  }));
export type RestartSessionRunnerResultV1 = z.infer<typeof RestartSessionRunnerResultV1Schema>;

/** Preserve a status/restart read failure without inferring a daemon version from missing data. */
export function projectSessionRunnerReadFailureV1(sessionId: string, value: unknown): RestartSessionRunnerResultV1 {
  const record = value && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : {};
  const errorCode = readRpcErrorCode(value)
    ?? (isMachineRpcTimeoutError(value) ? MACHINE_RPC_TIMEOUT_ERROR_CODE : undefined)
    ?? (typeof record.errorCode === 'string' ? record.errorCode : undefined);
  if (isRpcMethodNotFoundResult(value) || errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || errorCode === 'METHOD_NOT_FOUND' || errorCode === 'unsupported_daemon_version') {
    return { ok: false, sessionId, status: 'unsupported_daemon', reasonCode: 'unsupported_daemon_version' };
  }
  return { ok: false, sessionId, status: 'partial_failure', diagnostics: { errorCode: errorCode ?? 'invalid_response' } };
}

/** One request witness policy for the banner and public runtime-refresh Action. */
export function readSessionRunnerRestartIdentityGuardV1(runtimeState: SessionRunnerRuntimeStateV1): Readonly<{
  expectedRunnerPid: number;
  expectedProcessCommandHash: string;
  expectedRunnerEntrypointIdentity: string;
}> | RestartSessionRunnerResultV1 {
  const refused = (status: RestartSessionRunnerResultV1['status'], reasonCode: SessionRunnerRestartDisabledReason): RestartSessionRunnerResultV1 => ({
    ok: false, sessionId: runtimeState.sessionId, status, reasonCode,
  });
  if (runtimeState.runner.pid == null) return refused('runner_not_active', 'no_tracked_process');
  const expectedProcessCommandHash = runtimeState.runner.processCommandHash?.trim();
  const expectedRunnerEntrypointIdentity = runtimeState.runner.entrypointSource === 'unknown'
    ? null : runtimeState.runner.runtimeId?.trim();
  if (!expectedProcessCommandHash || !expectedRunnerEntrypointIdentity) {
    return refused('version_unknown', 'runner_entrypoint_unknown');
  }
  if (runtimeState.daemon.currentEntrypointSource === 'unknown' || !runtimeState.daemon.currentEntrypointVersion?.trim()) {
    return refused('version_unknown', 'current_entrypoint_unknown');
  }
  return { expectedRunnerPid: runtimeState.runner.pid, expectedProcessCommandHash, expectedRunnerEntrypointIdentity };
}

export function buildSessionRunnerRuntimeRefreshRequestV1(runtimeState: SessionRunnerRuntimeStateV1): RestartSessionRunnerRequestV1 | RestartSessionRunnerResultV1 {
  const guard = readSessionRunnerRestartIdentityGuardV1(runtimeState);
  if ('ok' in guard) return guard;
  return RestartSessionRunnerRequestV1Schema.parse({ sessionId: runtimeState.sessionId,
    mode: 'if_stale', reason: 'ui_stale_runner_banner', ...guard });
}

export const RestartAllSessionRunnersRequestV1Schema = lazyZodSchema(() => z.strictObject({
    mode: SessionRunnerRestartModeV1Schema,
    dryRun: z.optional(z.boolean()),
    reason: SessionRunnerRestartReasonV1Schema,
  }));
export type RestartAllSessionRunnersRequestV1 =
  z.infer<typeof RestartAllSessionRunnersRequestV1Schema>;

export const RestartAllSessionRunnersResultV1Schema = lazyZodSchema(() => z.strictObject({
    ok: z.boolean(),
    mode: SessionRunnerRestartModeV1Schema,
    requestedCount: z.number().check(z.int(), z.nonnegative()),
    restartedCount: z.number().check(z.int(), z.nonnegative()),
    skippedCount: z.number().check(z.int(), z.nonnegative()),
    failedCount: z.number().check(z.int(), z.nonnegative()),
    results: z.array(RestartSessionRunnerResultV1Schema),
  }).check(z.superRefine((value, ctx) => {
    if (value.requestedCount !== value.results.length) {
      ctx.addIssue({
        code: "custom",
        path: ['requestedCount'],
        message: 'requestedCount must match results length',
      });
    }
    if (value.restartedCount + value.skippedCount + value.failedCount !== value.requestedCount) {
      ctx.addIssue({
        code: "custom",
        path: ['requestedCount'],
        message: 'restart result counts must sum to requestedCount',
      });
    }
  })));
export type RestartAllSessionRunnersResultV1 =
  z.infer<typeof RestartAllSessionRunnersResultV1Schema>;
