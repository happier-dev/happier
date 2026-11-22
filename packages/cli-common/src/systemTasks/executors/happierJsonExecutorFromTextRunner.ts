import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { readGuestCliFailureOutput } from '@happier-dev/protocol/ssh/commandFailure';
import type { ManagedNativeFailureDetailsV1 } from '@happier-dev/protocol/actions/operations/v1';
import { SystemTaskExecutionError } from '../runSystemTask.js';

export type HappierTextResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

export type RunHappierOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  /** `null` delegates the deadline to the invoked operation's lifecycle owner. */
  timeoutMs?: number | null;
  onStdoutChunk?: (text: string) => void;
  includeStdoutInError?: boolean;
  /** Ephemeral process input. Callers must keep credentials and durable secrets out. */
  input?: string;
}>;

export interface HappierJsonExecutor {
  runHappierText(args: readonly string[], opts?: RunHappierOptions): Promise<HappierTextResult>;
  runHappierJson(
    args: readonly string[],
    opts?: RunHappierOptions & Readonly<{ allowJsonFailure?: boolean }>,
  ): Promise<unknown>;
}

/** Transports supply process IO; CLI JSON success/failure stays transport-neutral. */
export function createHappierJsonExecutorFromTextRunner(runHappierText: HappierJsonExecutor['runHappierText']): HappierJsonExecutor {
  return {
    runHappierText,
    async runHappierJson(args, opts) {
      const result = await runHappierText(args, opts);
      const parsed = parseFirstJsonObject(result.stdout);
      if (result.status !== 0) {
        if (opts?.allowJsonFailure && parsed && typeof parsed === 'object') return parsed;
        throw new SystemTaskExecutionError('cli_command_failed', result.stderr.trim() || result.stdout.trim() || 'Command failed.',
          { details: projectGuestCommandFailure(args, result) });
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new SystemTaskExecutionError('invalid_cli_response', `Command did not return a JSON object: ${args.join(' ')}`);
      }
      if (!opts?.allowJsonFailure && isJsonFailureEnvelope(parsed)) {
        const envelope = parsed as { error?: unknown; message?: unknown };
        const error = envelope.error;
        const message = typeof envelope.message === 'string' && envelope.message.trim()
          ? envelope.message.trim()
          : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
            ? error.message.trim()
            : `Command failed: ${args.join(' ')}`;
        throw new SystemTaskExecutionError('cli_command_failed', message, { details: projectGuestCommandFailure(args, result) });
      }
      return parsed;
    },
  };
}

/**
 * The failed guest step and its redacted output, as the existing native failure facts. The step comes from the
 * command words only (never values or flags); output passes the shared redaction before it can cross a boundary.
 */
function projectGuestCommandFailure(args: readonly string[], result: HappierTextResult): ManagedNativeFailureDetailsV1 {
  const words: string[] = [];
  for (const arg of args.slice(readLocalCommandOffset(args))) {
    if (words.length === 2 || !/^[a-z][a-z0-9_-]*$/u.test(arg)) break;
    words.push(arg.replaceAll('-', '_'));
  }
  const guest = readGuestCliFailureOutput(result.stdout, result.stderr);
  const output = redactBugReportSensitiveText(result.stderr.trim() || result.stdout.trim());
  const stderr = output.slice(-MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1);
  return { kind: 'managedNative', nativeCause: { localCause: 'native_command_failed', command: 'run', exitCode: result.status,
    failureCause: { phase: ['guest_cli', ...(words.length ? words : ['command'])].join('.'), errorClass: 'Error', errorCode: 'cli_command_failed',
      ...(guest?.guestCliCode ? { nativeErrorCode: guest.guestCliCode } : {}), httpStatus: guest?.guestHttpStatus ?? null },
    ...(stderr ? { stderr } : {}), ...(stderr.length < output.length ? { stderrTruncated: true as const } : {}) } };
}

function parseFirstJsonObject(text: string): unknown {
  const lines = String(text ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function isJsonFailureEnvelope(value: unknown): value is Readonly<{ ok: false }> {
  return Boolean(
    value
      && typeof value === 'object'
      && 'ok' in value
      && (value as { ok?: unknown }).ok === false,
  );
}

function readLocalCommandOffset(args: readonly string[]): number {
  return args[0] === '--server' ? 2 : args[0]?.startsWith('--server=') ? 1 : 0;
}

export function readLocalServiceAction(args: readonly string[]): string | null {
  const commandOffset = readLocalCommandOffset(args);
  const serviceOffset = commandOffset + (args[commandOffset] === 'daemon' ? 1 : 0);
  return args[serviceOffset] === 'service' ? args[serviceOffset + 1] ?? null : null;
}

/** Delegated tasks and service mutations keep their operation's lifecycle and cancellation. */
export function resolveLocalHappierCommandTimeoutMs(args: readonly string[]): number | null | undefined {
  const commandOffset = readLocalCommandOffset(args);
  if (args[commandOffset] === 'daemon' && args[commandOffset + 1] === 'system-task') return null;
  return ['install', 'start', 'stop', 'restart'].includes(readLocalServiceAction(args) ?? '')
    && !args.includes('--dry-run')
    ? null
    : undefined;
}
