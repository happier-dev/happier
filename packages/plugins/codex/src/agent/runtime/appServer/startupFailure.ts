import { readSessionRuntimeIssueCode } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

const CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE = 'CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE';

export function isCodexRealtimeEnabledAppServerLaunchUnavailableError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error
    && error.code === CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE);
}

export function createCodexRealtimeEnabledAppServerLaunchUnavailableError(cause: unknown): Error {
  const error = new Error('The realtime-enabled Codex app-server launch was unavailable.', { cause });
  Object.defineProperty(error, 'code', { value: CODEX_REALTIME_ENABLED_LAUNCH_UNAVAILABLE, enumerable: true });
  return error;
}

/** Cleanup aggregates put the initiating failure first; realtime adds presentation only. */
export function readCodexAppServerPrimaryFailure(error: unknown): unknown {
  if (error instanceof AggregateError) return readCodexAppServerPrimaryFailure(error.errors[0]);
  if (isCodexRealtimeEnabledAppServerLaunchUnavailableError(error)
    && error instanceof Error && error.cause !== undefined) {
    return readCodexAppServerPrimaryFailure(error.cause);
  }
  return error;
}

/** Typed failures are terminal even when another SDK instance constructed them. */
export function readCodexAppServerProbeFailureCode(error: unknown): string | null {
  const primary = readCodexAppServerPrimaryFailure(error);
  return readSessionRuntimeIssueCode(primary && typeof primary === 'object' && 'code' in primary
    ? primary.code : undefined);
}
