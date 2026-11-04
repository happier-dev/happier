import { trimBugReportTextHeadToMaxBytes, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import { SESSION_SPAWN_CHILD_STDERR_MAX_BYTES, type SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/spawnSession';
import { sanitizeConnectedServiceDiagnosticString } from '../connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
import { readSessionRunnerFailureCause, SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import type { ChildExit } from '../sessions/onChildExited';

const CHILD_STDERR_CAPTURE_MAX_CHARS = 16_384;

export type CapturedChildStderr = Readonly<{
  head: string;
  tail: string;
  failureCause?: SessionSpawnLaunchErrorV1['failureCause'];
}>;

/** Tail-only consumers such as MCP probing keep their existing capture contract. */
export function appendBoundedStderrTail(current: string, chunk: unknown): string {
  const next = `${current}${String(chunk ?? '')}`;
  return next.length > CHILD_STDERR_CAPTURE_MAX_CHARS
    ? next.slice(-CHILD_STDERR_CAPTURE_MAX_CHARS)
    : next;
}

export function appendBoundedChildStderr(current: CapturedChildStderr, chunk: unknown): CapturedChildStderr {
  // Share the existing capture budget between the startup head and exit-report
  // tail. One stream owner retains both ends; long tracebacks cannot erase the cause.
  const windowMaxChars = CHILD_STDERR_CAPTURE_MAX_CHARS / 2;
  const text = String(chunk ?? '');
  // Retain the validated terminal record even when earlier warnings and a
  // later traceback fill both diagnostic windows. The existing tail joins
  // records split across OS stream chunks without another buffer.
  const failureCause = current.failureCause ?? readSessionRunnerFailureCause(`${current.tail}${text}`);
  return {
    head: current.head.length >= windowMaxChars ? current.head : `${current.head}${text}`.slice(0, windowMaxChars),
    tail: appendBoundedStderrTail(current.tail, text).slice(-windowMaxChars),
    ...(failureCause ? { failureCause } : {}),
  };
}

export function sanitizeChildStderrTail(
  stderrTail: string,
  sanitizeDiagnosticText: (value: string) => string,
): string | null {
  const trimmed = stderrTail.trim();
  if (!trimmed) return null;
  const redacted = sanitizeConnectedServiceDiagnosticString(sanitizeDiagnosticText(trimmed), {
    maxLength: CHILD_STDERR_CAPTURE_MAX_CHARS,
  });
  return trimBugReportTextToMaxBytes(redacted, SESSION_SPAWN_CHILD_STDERR_MAX_BYTES).trim() || null;
}

/** One projection for the process observer and startup-custody settlement. */
export function buildChildExitBeforeWebhookFailure(
  input: Readonly<{ pid: number; reason?: string } & Omit<ChildExit, 'reason'>>,
  sanitizeDiagnosticText: (value: string) => string = value => value,
) {
  const captured = sanitizeDiagnosticText(input.stderrTail ?? '');
  const stderrHead = trimBugReportTextHeadToMaxBytes(
    sanitizeConnectedServiceDiagnosticString(captured, { maxLength: CHILD_STDERR_CAPTURE_MAX_CHARS }),
    SESSION_SPAWN_CHILD_STDERR_MAX_BYTES,
  ).trim();
  const missing = /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)\b/u.test(captured)
    ? /Cannot find (?:module|package)\s+['"]([^'"\r\n]+)['"]/u.exec(captured)?.[1]
    : undefined;
  const basename = missing?.split(/[/\\]/u).at(-1);
  const safeBasename = basename ? sanitizeConnectedServiceDiagnosticString(basename, {
    maxLength: CHILD_STDERR_CAPTURE_MAX_CHARS,
  }) : '';
  const cause = safeBasename && !safeBasename.includes('[REDACTED]')
    && trimBugReportTextHeadToMaxBytes(safeBasename, SESSION_SPAWN_CHILD_STDERR_MAX_BYTES) === safeBasename
    && /^[^/\\\u0000-\u001f\u007f]+$/u.test(safeBasename)
    ? { kind: 'module_not_found' as const, specifierBasename: safeBasename } : undefined;
  const childExit = input.childExit ?? {
    code: input.code,
    signal: input.signal,
    ...(stderrHead ? { stderrHead } : {}),
    ...(cause ? { cause } : {}),
  };
  const message = formatChildExitBeforeWebhookMessage({ ...input, stderrTail: childExit.stderrHead })
    + (childExit.cause ? `; ${childExit.cause.kind}: ${childExit.cause.specifierBasename}` : '');
  const errorDetail = {
    kind: 'launch_error', code: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
    message, childExit,
    ...(input.failureCause ? { failureCause: input.failureCause } : {}),
  } satisfies SessionSpawnLaunchErrorV1;
  return { type: 'error' as const, errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
    errorMessage: message, errorDetail };
}

export function formatChildExitBeforeWebhookMessage(input: Readonly<{
  pid: number;
  reason?: string;
  code: number | null;
  signal: string | null;
  stderrTail?: string | null;
}>): string {
  const stderrTail = sanitizeChildStderrTail(input.stderrTail ?? '', value => value);
  const message = `Child process exited before session webhook (pid=${input.pid}, code=${input.code ?? 'null'}, signal=${input.signal ?? 'null'}${input.reason ? `, reason=${input.reason}` : ''})`;
  return stderrTail ? `${message}; recent stderr: ${stderrTail}` : message;
}
