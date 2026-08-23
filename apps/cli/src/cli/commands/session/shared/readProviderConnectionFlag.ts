import { hasFlagValue, readFlagValue } from '@/cli/commands/shared/argvFlags';

export const SESSION_NATIVE_PROVIDER_CONNECTION_TOKEN = 'native';

/**
 * Reads the exact Provider connection a session model selection targets.
 *
 * `--provider-connection <id>` names one connection, mirroring
 * `happier session create`. `--provider-connection native` is the explicit
 * Agent-native source, which the Action contract represents as a null
 * connection id. Omitting the flag leaves the current selection untouched.
 */
export function readProviderConnectionFlag(
  argv: readonly string[],
): string | null | undefined {
  if (!hasFlagValue(argv, '--provider-connection')) return undefined;
  const value = readFlagValue(argv, '--provider-connection');
  if (value === null || value.startsWith('-')) {
    const error = new Error(
      `--provider-connection requires a Provider connection id or '${SESSION_NATIVE_PROVIDER_CONNECTION_TOKEN}'`,
    );
    (error as { code?: string }).code = 'invalid_arguments';
    throw error;
  }
  return value === SESSION_NATIVE_PROVIDER_CONNECTION_TOKEN ? null : value;
}
