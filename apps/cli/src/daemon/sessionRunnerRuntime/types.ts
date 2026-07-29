import type {
  SessionRunnerEntrypointSourceV1,
  SessionRunnerRestartDisabledReason,
  SessionRunnerRuntimeStateV1,
  SessionRunnerRuntimeStatusSourceV1,
  SessionRunnerVersionStateV1,
} from '@happier-dev/protocol';

export type SessionRunnerEntrypointIdentitySource = SessionRunnerEntrypointSourceV1;

export type KnownSessionRunnerEntrypointIdentity = Readonly<{
  status: 'known';
  source: Exclude<SessionRunnerEntrypointIdentitySource, 'unknown'>;
  comparableId: string;
  entrypointVersion?: string | null;
}>;

export type UnknownSessionRunnerEntrypointIdentity = Readonly<{
  status: 'unknown';
  source: 'unknown';
  reason:
    | 'entrypoint_not_found'
    | 'mutable_entrypoint_pointer'
    | 'empty_command'
    | 'empty_launch_spec'
    | 'unsupported_launch_spec';
}>;

export type SessionRunnerEntrypointIdentity =
  | KnownSessionRunnerEntrypointIdentity
  | UnknownSessionRunnerEntrypointIdentity;

export type SessionRunnerVersionState = SessionRunnerVersionStateV1;
export type SessionRunnerRuntimeStatusSource = SessionRunnerRuntimeStatusSourceV1;
export type { SessionRunnerRestartDisabledReason };
export type SessionRunnerRuntimeState = SessionRunnerRuntimeStateV1;
