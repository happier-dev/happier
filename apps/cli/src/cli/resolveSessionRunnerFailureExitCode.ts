import { HostTerminalTranscriptFollowAdmissionError } from '@/agent/runtime/session/terminal/contract';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { logger } from '@/ui/logger';
import { classifyPrimarySessionRuntimeIssue, readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { writeConsoleErrorBestEffort } from '@/utils/writeConsoleBestEffort';
import {
  isAgentSessionContinuationUnreachableError,
  SESSION_RUNNER_EXIT_CODES,
  formatSessionRunnerFailureCause,
} from '@/session/shared/spawnSessionContract';

/** Preserve non-retryable host admission failures across the runner process boundary. */
export function resolveSessionRunnerFailureExitCode(error: unknown): number {
  if (isAgentSessionContinuationUnreachableError(error)) {
    return SESSION_RUNNER_EXIT_CODES.CONTINUATION_UNREACHABLE;
  }
  // Binding failed before a terminal child existed. Repeating the same launch
  // cannot supply the missing admission; the preserved Session can be retried explicitly.
  if (error instanceof HostTerminalTranscriptFollowAdmissionError && error.phase === 'bind') {
    return SESSION_RUNNER_EXIT_CODES.TERMINAL_FOLLOW_ADMISSION_FAILED;
  }
  // A refused requester cannot be supplied by repeating this same runner.
  // Keep the existing terminal admission disposition and explicit Resume recovery.
  if (isPluginError(error) && error.code === 'project_requester_credentials_unavailable') {
    return SESSION_RUNNER_EXIT_CODES.TERMINAL_FOLLOW_ADMISSION_FAILED;
  }
  return 1;
}

/** Report the command failure and preserve its existing supervised process exit. */
export function reportSessionRunnerFailure(error: unknown): number {
  const exitCode = resolveSessionRunnerFailureExitCode(error);
  const { originalCode, failureCause } = readSessionPreparationFailureDiagnostic(error);
  if (failureCause) writeConsoleErrorBestEffort(formatSessionRunnerFailureCause(failureCause));
  const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
  logger.infoFile('[Session] Runner failed', {
    phase: 'runner_exit', exitCode,
    ...diagnostic,
    errorCode: originalCode === 'unknown' ? diagnostic.errorCode : originalCode,
    ...(failureCause ? { failureCause } : {}),
  });
  const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error });
  if (issue.source === 'dependency_failure' && issue.code === 'preparation_pending') {
    logger.infoFile('[Session] Startup preparation pending', { code: issue.code, source: issue.source });
  } else {
    logger.fatal(error);
  }
  return exitCode;
}
