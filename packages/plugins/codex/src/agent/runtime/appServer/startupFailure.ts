import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { redactBugReportSensitiveText } from '@happier-dev/plugin-sdk';
import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { readSessionRuntimeIssueCode } from '@happier-dev/plugin-sdk/sessions';

import { resolveCodexHome } from '../../mcp/configServers.js';

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

function fingerprintLaunchPath(runtimeHome: string, path: string | null): string | null {
  if (!path || !isAbsolute(path) || !isAbsolute(runtimeHome)) return null;
  const fromHome = relative(runtimeHome, path);
  // Windows cannot express another volume relative to the selected home.
  if (isAbsolute(fromHome)) return null;
  return createHash('sha256').update((fromHome || '.').split(sep).join('/')).digest('hex');
}

/** Publish only content-free evidence from the refused initialization. */
export function projectCodexContinuationInitializeFailure(input: Readonly<{
  error: unknown;
  env: Readonly<Record<string, string | undefined>>;
  requestedSqliteHome: string | null;
}>): Readonly<{ cause: ActionFailureCauseV1; localDetails: Readonly<Record<string, string>> }> {
  const primary = readCodexAppServerPrimaryFailure(input.error);
  const phase = 'codex.app_server_initialize';
  const { errorClass, errorCode, httpStatus } = projectActionFailureCauseV1(primary, phase);
  const stderr = primary instanceof Error && 'stderrPreview' in primary && typeof primary.stderrPreview === 'string'
    ? primary.stderrPreview : '';
  let nativeErrorReason = 'stderr_unavailable';
  if (/\b(?:EACCES|EPERM|permission denied|read-only file system)\b/iu.test(stderr)) {
    nativeErrorReason = 'stderr_permissions';
  } else if (/\b(?:sqlite|database is (?:locked|busy|malformed)|unable to open database file)\b/iu.test(stderr)) {
    nativeErrorReason = 'stderr_sqlite';
  } else if (stderr.trim()) {
    nativeErrorReason = 'stderr_other';
  }
  const runtimeHome = resolveHomeDirFromEnvironment(input.env);
  return {
    cause: {
      phase, errorClass, errorCode, httpStatus, nativeErrorReason,
      codexLaunchPathIdentity: {
        codexHome: fingerprintLaunchPath(runtimeHome, resolveCodexHome(input.env)),
        sqliteHome: fingerprintLaunchPath(runtimeHome, input.requestedSqliteHome),
      },
    },
    localDetails: {
      ...(primary instanceof Error ? { nativeMessage: redactBugReportSensitiveText(primary.message) } : {}),
      ...(stderr ? { nativeStderr: redactBugReportSensitiveText(stderr) } : {}),
    },
  };
}

/** Typed failures are terminal even when another SDK instance constructed them. */
export function readCodexAppServerProbeFailureCode(error: unknown): string | null {
  const primary = readCodexAppServerPrimaryFailure(error);
  return readSessionRuntimeIssueCode(primary && typeof primary === 'object' && 'code' in primary
    ? primary.code : undefined);
}
