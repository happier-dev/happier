import { redactBugReportSensitiveText, trimBugReportTextToMaxBytes } from '@happier-dev/protocol/bugs/reports/redaction';
import { findPluginDiagnosticSourceLocation, type PluginDiagnosticSourceLocation } from '@/plugins/validation/diagnostics/sourceLocation';
import type { PluginAuthorToolchainDiagnostic, PluginAuthorToolchainOperation, PluginAuthorToolchainSpawnResult } from './toolchain';

// Author failures carry a diagnostic excerpt rather than a full compiler or
// install log. The shared UTF-8 trimmer marks any omitted prefix.
const diagnosticTailBytes = 8_192;

function diagnosticTail(stderr: string, stdout: string): string {
  return trimBugReportTextToMaxBytes(redactBugReportSensitiveText(stderr.trim() || stdout.trim()), diagnosticTailBytes);
}

export function createDiagnostic(
  code: PluginAuthorToolchainDiagnostic['code'],
  message: string,
  source?: PluginDiagnosticSourceLocation,
): PluginAuthorToolchainDiagnostic {
  return { code, message: redactBugReportSensitiveText(message), ...(source ? { source } : {}) };
}

export function childToolFailureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  if (typeof error !== 'object' || error === null) return message;
  const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number')
    ? ` (${error.code})` : '';
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
  const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
  const diagnostic = diagnosticTail(stderr, stdout);
  return `${message}${code}${diagnostic ? `\n${diagnostic}` : ''}`;
}

function processFailureMessage(operation: PluginAuthorToolchainOperation, result: PluginAuthorToolchainSpawnResult): string {
  const detail = diagnosticTail(result.stderr, result.stdout);
  const suffix = detail ? `: ${detail}` : '';
  return `Plugin development ${operation} failed with ${result.signal ?? result.exitCode ?? 'unknown status'}${suffix}`;
}

/**
 * The one author-facing projection of a failed toolchain process. The compiler,
 * the test runner, and the Plugin UI builder all report `file(line,column)` or
 * `file:line:column` relative to the project root they were spawned in, so the
 * first contained location in their output is the line the author must fix.
 * `stderr` is read before `stdout` because a tool that separates them puts the
 * failure there.
 */
export function processFailureDiagnostic(params: Readonly<{
  operation: PluginAuthorToolchainOperation;
  projectRoot: string;
  code: PluginAuthorToolchainDiagnostic['code'];
  result: PluginAuthorToolchainSpawnResult;
}>): PluginAuthorToolchainDiagnostic {
  const source = findPluginDiagnosticSourceLocation({
    texts: [params.result.stderr, params.result.stdout],
    sourceRoot: params.projectRoot,
  });
  return createDiagnostic(
    params.code,
    processFailureMessage(params.operation, params.result),
    source ?? undefined,
  );
}
