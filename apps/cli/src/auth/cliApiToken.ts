import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseAccountApiTokenBearerV1, parseAccountApiTokenCredentialV1 } from '@happier-dev/protocol/auth/accountApiTokenCredentialV1';

import { CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV } from './cliApiTokenEnvironment';
export { CLI_API_TOKEN_ENV, CLI_API_TOKEN_HANDOFF_ENV, stripCliApiTokenEnvironment, takeCliApiTokenEnvironment } from './cliApiTokenEnvironment';

const invocationApiTokenStore = new AsyncLocalStorage<Readonly<{ token: string }>>();

export class CliApiTokenInputError extends Error {
  readonly code = 'invalid_arguments' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CliApiTokenInputError';
  }
}

export class CliApiTokenChildContinuationError extends Error {
  readonly code = 'api_token_child_continuation_unsupported' as const;

  constructor() {
    super('Encryption-capable API tokens can only be used by in-process SDK calls; child-session continuation is unsupported.');
    this.name = 'CliApiTokenChildContinuationError';
  }
}

function validateApiToken(raw: unknown, source: '--api-token' | typeof CLI_API_TOKEN_ENV): string {
  const value = typeof raw === 'string' ? raw : '';
  if (parseAccountApiTokenBearerV1(value) === null && parseAccountApiTokenCredentialV1(value) === null) {
    throw new CliApiTokenInputError(
      `Invalid ${source}. Use an exact API Token created in Settings.`,
    );
  }
  return value;
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
function resolveInvocationCredential(env: NodeJS.ProcessEnv): string | null {
  const invocation = invocationApiTokenStore.getStore();
  if (invocation) return invocation.token;

  const envValue = env[CLI_API_TOKEN_ENV];
  if (envValue === undefined) return null;
  return validateApiToken(envValue, CLI_API_TOKEN_ENV);
}

/** Generic credential readers and HTTP transports receive only the bearer. */
export function resolveCliApiToken(env: NodeJS.ProcessEnv = sessionProcessEnvironment()): string | null {
  const credential = resolveInvocationCredential(env);
  return credential === null ? null : parseAccountApiTokenCredentialV1(credential)?.bearer ?? credential;
}

/** Only the in-process SDK may consume the matching invocation's local secret. */
export function resolveCliApiTokenForSdk(bearer: string, env: NodeJS.ProcessEnv = sessionProcessEnvironment()): string {
  const credential = resolveInvocationCredential(env);
  return credential !== null && parseAccountApiTokenCredentialV1(credential)?.bearer === bearer
    ? credential
    : bearer;
}

/**
 * The only intentional child-environment transfer: an ordinary bearer reaches
 * the next Happier CLI process across tmux, where dispatch consumes and deletes
 * it before any generic agent or PTY launch. Compound credentials fail closed;
 * their local wrapping secret never crosses a child boundary.
 */
export function buildCliApiTokenContinuationEnvironment(
  environment: NodeJS.ProcessEnv = sessionProcessEnvironment(),
): Record<string, string> {
  const credential = resolveInvocationCredential(environment);
  if (credential === null) return {};
  if (parseAccountApiTokenCredentialV1(credential) !== null) {
    throw new CliApiTokenChildContinuationError();
  }
  return { [CLI_API_TOKEN_HANDOFF_ENV]: credential };
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

/** One declaration of secret CLI flags and their supported stdin aliases. */
export const SENSITIVE_CLI_VALUE_FLAG_DEFINITIONS = Object.freeze([
  { flag: '--api-token' },
  { flag: '--password', stdinField: 'password' },
  { flag: '--current-password', stdinField: 'currentPassword' },
  { flag: '--new-password', stdinField: 'newPassword' },
  { flag: '--key', stdinField: 'recoveryKey' },
  { flag: '--recovery-key' },
  { flag: '--token', stdinField: 'resetToken' },
  { flag: '--invitation-token', stdinField: 'invitationToken' },
  { flag: '--verification-token', stdinField: 'verificationToken' },
  { flag: '--reauth-proof-json' },
] as const);
export const SENSITIVE_CLI_VALUE_FLAG_NAMES = Object.freeze(SENSITIVE_CLI_VALUE_FLAG_DEFINITIONS.map(({ flag }) => flag));
const SENSITIVE_CLI_VALUE_FLAGS: ReadonlySet<string> = new Set(SENSITIVE_CLI_VALUE_FLAG_NAMES);

export function isSensitiveCliValueFlag(flag: string): boolean {
  return SENSITIVE_CLI_VALUE_FLAGS.has(flag);
}
