import { z } from 'zod';

import { SessionRunnerRestartDisabledReasonSchema } from './sessionRunnerRestartV1.js';

export const SESSION_RUNNER_RUNTIME_STATE_FIELD_ID = 'runtime.sessionRunner' as const;
export const SESSION_RUNNER_RUNTIME_METADATA_KEY = 'sessionRunnerRuntimeV1' as const;

const SessionRunnerSessionIdV1Schema = z.string().trim().min(1);
const SessionRunnerIdentityV1Schema = z.string().trim().min(1);
const SessionRunnerPidV1Schema = z.number().int().positive();
const SessionRunnerTimestampMsV1Schema = z.number().int().nonnegative();
const NullableIdentityFieldV1Schema = SessionRunnerIdentityV1Schema.nullable().optional();

export const SessionRunnerEntrypointSourceV1Schema = z.enum([
  'structured_state',
  'process_command',
  'launch_spec',
  'unknown',
]);
export type SessionRunnerEntrypointSourceV1 = z.infer<typeof SessionRunnerEntrypointSourceV1Schema>;

export const SessionRunnerDaemonEntrypointSourceV1Schema = z.enum([
  'launch_spec',
  'packaged_runtime',
  'override',
  'unknown',
]);
export type SessionRunnerDaemonEntrypointSourceV1 =
  z.infer<typeof SessionRunnerDaemonEntrypointSourceV1Schema>;

export const SessionRunnerStartedByV1Schema = z.enum(['daemon', 'local', 'unknown']);
export type SessionRunnerStartedByV1 = z.infer<typeof SessionRunnerStartedByV1Schema>;

export const SessionRunnerStartingModeV1Schema = z.enum(['remote', 'local', 'unknown']);
export type SessionRunnerStartingModeV1 = z.infer<typeof SessionRunnerStartingModeV1Schema>;

export const SessionRunnerVersionStateV1Schema = z.enum(['current', 'stale', 'unknown']);
export type SessionRunnerVersionStateV1 = z.infer<typeof SessionRunnerVersionStateV1Schema>;

export const SessionRunnerRuntimeStatusSourceV1Schema = z.enum([
  'daemon_tracking',
  'runner_marker',
  'runner_report',
  'process_command_inferred',
  'unknown',
]);
export type SessionRunnerRuntimeStatusSourceV1 =
  z.infer<typeof SessionRunnerRuntimeStatusSourceV1Schema>;

const SessionRunnerRuntimeRunnerV1Schema = z
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
  .strict();

const SessionRunnerRuntimeDaemonV1Schema = z
  .object({
    cliVersion: NullableIdentityFieldV1Schema,
    startedWithCliVersion: NullableIdentityFieldV1Schema,
    currentEntrypointVersion: NullableIdentityFieldV1Schema,
    currentEntrypointSource: SessionRunnerDaemonEntrypointSourceV1Schema,
  })
  .strict();

const SessionRunnerPlannedRestartStateV1Schema = z
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
  });

export const SessionRunnerRuntimeStateV1Schema = z
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
  .strict();
export type SessionRunnerRuntimeStateV1 = z.infer<typeof SessionRunnerRuntimeStateV1Schema>;

export const SessionRunnerStatusGetRequestV1Schema = z
  .object({
    sessionId: SessionRunnerSessionIdV1Schema,
  })
  .strict();
export type SessionRunnerStatusGetRequestV1 =
  z.infer<typeof SessionRunnerStatusGetRequestV1Schema>;
