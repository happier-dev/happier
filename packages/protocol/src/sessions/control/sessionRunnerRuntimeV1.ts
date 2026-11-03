import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionRunnerRestartDisabledReasonSchema, projectSessionRunnerReadFailureV1, type RestartSessionRunnerResultV1 } from './sessionRunnerRestartV1.js';

export const SESSION_RUNNER_RUNTIME_STATE_FIELD_ID = 'runtime.sessionRunner' as const;
export const SESSION_RUNNER_RUNTIME_METADATA_KEY = 'sessionRunnerRuntimeV1' as const;

const SessionRunnerSessionIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SessionRunnerIdentityV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const SessionRunnerPidV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.positive()));
const SessionRunnerTimestampMsV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const NullableIdentityFieldV1Schema = lazyZodSchema(() => z.optional(z.nullable(SessionRunnerIdentityV1Schema)));

export const SessionRunnerEntrypointSourceV1Schema = lazyZodSchema(() => z.enum([
  'structured_state',
  'process_command',
  'launch_spec',
  'unknown',
]));
export type SessionRunnerEntrypointSourceV1 = z.infer<typeof SessionRunnerEntrypointSourceV1Schema>;

export const SessionRunnerDaemonEntrypointSourceV1Schema = lazyZodSchema(() => z.enum([
  'launch_spec',
  'packaged_runtime',
  'override',
  'unknown',
]));
export type SessionRunnerDaemonEntrypointSourceV1 =
  z.infer<typeof SessionRunnerDaemonEntrypointSourceV1Schema>;

export const SessionRunnerStartedByV1Schema = lazyZodSchema(() => z.enum(['daemon', 'local', 'unknown']));
export type SessionRunnerStartedByV1 = z.infer<typeof SessionRunnerStartedByV1Schema>;

export const SessionRunnerStartingModeV1Schema = lazyZodSchema(() => z.enum(['remote', 'local', 'unknown']));
export type SessionRunnerStartingModeV1 = z.infer<typeof SessionRunnerStartingModeV1Schema>;

export const SessionRunnerVersionStateV1Schema = lazyZodSchema(() => z.enum(['current', 'stale', 'unknown']));
export type SessionRunnerVersionStateV1 = z.infer<typeof SessionRunnerVersionStateV1Schema>;

export const SessionRunnerRuntimeStatusSourceV1Schema = lazyZodSchema(() => z.enum([
  'daemon_tracking',
  'runner_marker',
  'runner_report',
  'process_command_inferred',
  'unknown',
]));
export type SessionRunnerRuntimeStatusSourceV1 =
  z.infer<typeof SessionRunnerRuntimeStatusSourceV1Schema>;

const SessionRunnerRuntimeRunnerV1Schema = lazyZodSchema(() => z.strictObject({
    pid: z.optional(z.nullable(SessionRunnerPidV1Schema)),
    runtimeId: NullableIdentityFieldV1Schema,
    cliVersion: NullableIdentityFieldV1Schema,
    entrypointVersion: NullableIdentityFieldV1Schema,
    processCommandHash: NullableIdentityFieldV1Schema,
    entrypointSource: SessionRunnerEntrypointSourceV1Schema,
    startedBy: SessionRunnerStartedByV1Schema,
    startingMode: SessionRunnerStartingModeV1Schema,
  }));

const SessionRunnerRuntimeDaemonV1Schema = lazyZodSchema(() => z.strictObject({
    cliVersion: NullableIdentityFieldV1Schema,
    startedWithCliVersion: NullableIdentityFieldV1Schema,
    currentEntrypointVersion: NullableIdentityFieldV1Schema,
    currentEntrypointSource: SessionRunnerDaemonEntrypointSourceV1Schema,
  }));

const SessionRunnerPlannedRestartStateV1Schema = lazyZodSchema(() => z.strictObject({
    supported: z.boolean(),
    eligible: z.boolean(),
    disabledReason: z.optional(z.nullable(SessionRunnerRestartDisabledReasonSchema)),
  }).check(z.superRefine((value, ctx) => {
    if (value.eligible && !value.supported) {
      ctx.addIssue({
        code: "custom",
        path: ['eligible'],
        message: 'eligible planned restart requires supported planned restart',
      });
    }
  })));

export const SessionRunnerRuntimeStateV1Schema = lazyZodSchema(() => z.strictObject({
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
  }));
export type SessionRunnerRuntimeStateV1 = z.infer<typeof SessionRunnerRuntimeStateV1Schema>;

/** One target-identity decision after status decoding in CLI and UI refresh. */
export function readSessionRunnerRuntimeStateForRestartV1(
  state: SessionRunnerRuntimeStateV1,
  target: Readonly<{ sessionId: string; machineId: string }>,
): SessionRunnerRuntimeStateV1 | RestartSessionRunnerResultV1 {
  if (state.sessionId !== target.sessionId || (state.machineId !== target.machineId
    && !(state.machineId == null && state.runner.pid == null))) {
    return projectSessionRunnerReadFailureV1(target.sessionId, null);
  }
  // Before startup the daemon can have neither a tracked process nor its Machine identity.
  // The restart identity guard owns that runner_not_active decision.
  return state;
}

export const SessionRunnerStatusGetRequestV1Schema = lazyZodSchema(() => z.strictObject({
    sessionId: SessionRunnerSessionIdV1Schema,
  }));
export type SessionRunnerStatusGetRequestV1 =
  z.infer<typeof SessionRunnerStatusGetRequestV1Schema>;
