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
        throw new SystemTaskExecutionError('cli_command_failed', result.stderr.trim() || result.stdout.trim() || 'Command failed.');
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
        throw new SystemTaskExecutionError('cli_command_failed', message);
      }
      return parsed;
    },
  };
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

export function resolveLocalHappierCommandTimeoutMs(args: readonly string[]): number | null | undefined {
  return ['install', 'start', 'stop', 'restart'].includes(readLocalServiceAction(args) ?? '')
    && !args.includes('--dry-run')
    ? null
    : undefined;
}

export function readLocalServiceAction(args: readonly string[]): string | null {
  const commandOffset = args[0] === '--server' ? 2 : args[0]?.startsWith('--server=') ? 1 : 0;
  const serviceOffset = commandOffset + (args[commandOffset] === 'daemon' ? 1 : 0);
  return args[serviceOffset] === 'service' ? args[serviceOffset + 1] ?? null : null;
}
