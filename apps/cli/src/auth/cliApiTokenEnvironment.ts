import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

export const CLI_API_TOKEN_ENV = 'HAPPIER_TOKEN';
/** One-shot handoff for a selected --api-token across Happier's tmux re-exec. */
export const CLI_API_TOKEN_HANDOFF_ENV = 'HAPPIER_CLI_API_TOKEN_HANDOFF_V1';

const CLI_API_TOKEN_ENVIRONMENT_KEYS = new Set([
  CLI_API_TOKEN_ENV,
  CLI_API_TOKEN_HANDOFF_ENV,
]);

function getEnvironmentValueCaseInsensitive(
  environment: Readonly<Record<string, string | undefined>>,
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
  environment: Readonly<Record<string, string | undefined>>,
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
 * then clears both variables from the selected environment so generic descendants
 * cannot inherit either spelling. Validation stays at dispatch so a valid
 * explicit flag still wins over malformed ambient input.
 */
export function takeCliApiTokenEnvironment(
  environment: NodeJS.ProcessEnv = sessionProcessEnvironment(),
): Readonly<{ token: string; source: typeof CLI_API_TOKEN_ENV }> | null {
  const handoff = getEnvironmentValueCaseInsensitive(environment, CLI_API_TOKEN_HANDOFF_ENV);
  const ambient = getEnvironmentValueCaseInsensitive(environment, CLI_API_TOKEN_ENV);
  for (const key of Object.keys(environment)) {
    if (CLI_API_TOKEN_ENVIRONMENT_KEYS.has(key.toUpperCase())) delete environment[key];
  }
  const token = handoff ?? ambient;
  return token === undefined ? null : { token, source: CLI_API_TOKEN_ENV };
}


