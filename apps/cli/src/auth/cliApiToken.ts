import { AsyncLocalStorage } from 'node:async_hooks';
import { parseAccountApiTokenBearerV1 } from '@happier-dev/protocol';

export const CLI_API_TOKEN_ENV = 'HAPPIER_TOKEN';
/** One-shot handoff for a selected --api-token across Happier's tmux re-exec. */
export const CLI_API_TOKEN_HANDOFF_ENV = 'HAPPIER_CLI_API_TOKEN_HANDOFF_V1';

const invocationApiTokenStore = new AsyncLocalStorage<Readonly<{ token: string }>>();
const CLI_API_TOKEN_ENVIRONMENT_KEYS = new Set([
  CLI_API_TOKEN_ENV,
  CLI_API_TOKEN_HANDOFF_ENV,
]);

export class CliApiTokenInputError extends Error {
  readonly code = 'invalid_arguments' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CliApiTokenInputError';
  }
}

function validateApiToken(raw: unknown, source: '--api-token' | typeof CLI_API_TOKEN_ENV): string {
  const value = typeof raw === 'string' ? raw : '';
  if (parseAccountApiTokenBearerV1(value) === null) {
    throw new CliApiTokenInputError(
      `Invalid ${source}. Use an exact API Token created in Settings.`,
    );
  }
  return value;
}

function getEnvironmentValueCaseInsensitive(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const expected = name.toUpperCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === expected && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Removes ambient and continuation API Token variables from a generic child
 * environment. Only the tmux continuation intentionally reintroduces its
 * one-shot handoff below.
 */
export function stripCliApiTokenEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string' || CLI_API_TOKEN_ENVIRONMENT_KEYS.has(key.toUpperCase())) continue;
    stripped[key] = value;
  }
  return stripped;
}

/**
 * Takes the selected continuation token (if any) ahead of the ambient token,
 * then clears both variables from the current process so generic descendants
 * cannot inherit either spelling. Validation stays at dispatch so a valid
 * explicit flag still wins over malformed ambient input.
 */
export function takeCliApiTokenEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<{ token: string; source: typeof CLI_API_TOKEN_ENV }> | null {
  const handoff = getEnvironmentValueCaseInsensitive(environment, CLI_API_TOKEN_HANDOFF_ENV);
  const ambient = getEnvironmentValueCaseInsensitive(environment, CLI_API_TOKEN_ENV);
  for (const key of Object.keys(environment)) {
    if (CLI_API_TOKEN_ENVIRONMENT_KEYS.has(key.toUpperCase())) delete environment[key];
  }
  const token = handoff ?? ambient;
  return token === undefined ? null : { token, source: CLI_API_TOKEN_ENV };
}

export function validateCliApiTokenEnvironment(
  input: Readonly<{ token: string; source: typeof CLI_API_TOKEN_ENV }>,
): string {
  return validateApiToken(input.token, input.source);
}

/**
 * Reads the caller-provided API Token without persisting it or changing process.env.
 * A command-line flag is stored in the current invocation only; direct programmatic
 * callers use HAPPIER_TOKEN from their supplied environment.
 */
export function resolveCliApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const invocation = invocationApiTokenStore.getStore();
  if (invocation) return invocation.token;

  const envValue = env[CLI_API_TOKEN_ENV];
  if (envValue === undefined) return null;
  return validateApiToken(envValue, CLI_API_TOKEN_ENV);
}

/**
 * The only intentional child-environment transfer: a selected token reaches
 * the next Happier CLI process across tmux, where dispatch consumes and deletes
 * it before any generic agent or PTY launch.
 */
export function buildCliApiTokenContinuationEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const token = resolveCliApiToken(environment);
  return token === null ? {} : { [CLI_API_TOKEN_HANDOFF_ENV]: token };
}

export async function withCliApiToken<T>(token: string, run: () => Promise<T>): Promise<T> {
  return await invocationApiTokenStore.run(Object.freeze({ token }), run);
}

export function takePrefixCliApiTokenFlag(args: readonly string[]): Readonly<{
  token: string;
  rest: string[];
}> | null {
  const first = String(args[0] ?? '');
  if (first === '--api-token') {
    const value = String(args[1] ?? '');
    if (!value || value.startsWith('--')) {
      throw new CliApiTokenInputError('Missing value for --api-token.');
    }
    return { token: validateApiToken(value, '--api-token'), rest: args.slice(2) };
  }
  if (first.startsWith('--api-token=')) {
    const value = first.slice('--api-token='.length);
    if (!value) throw new CliApiTokenInputError('Missing value for --api-token.');
    return { token: validateApiToken(value, '--api-token'), rest: args.slice(1) };
  }
  return null;
}

/** Redacts only the explicit CLI spelling before argv reaches logs or command contexts. */
export function redactCliApiTokenArgv(argv: readonly string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] ?? '');
    if (value === '--api-token') {
      redacted.push(value);
      if (index + 1 < argv.length) {
        redacted.push('<redacted>');
        index += 1;
      }
      continue;
    }
    if (value.startsWith('--api-token=')) {
      redacted.push('--api-token=<redacted>');
      continue;
    }
    redacted.push(value);
  }
  return redacted;
}
