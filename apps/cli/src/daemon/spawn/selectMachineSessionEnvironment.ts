import { isValidEnvVarKey } from '@/terminal/runtime/envVarSanitization';
import { isAllowedExactEnvKey } from '@/utils/env/isAllowedExactEnvKey';

export const MACHINE_SESSION_FORWARD_ENV_KEY = 'HAPPIER_SESSION_FORWARD_ENV';

/** Only the execution host's daemon can select additional inherited variable names. */
export function selectMachineSessionEnvironment(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const selectedNames = new Set((processEnv[MACHINE_SESSION_FORWARD_ENV_KEY] ?? '').split(',').map(name => name.trim()));
  const selected: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(processEnv)) {
    if (typeof value !== 'string' || !isValidEnvVarKey(name)) continue;
    if (/^(?:HAPPIER|HAPPY)_/i.test(name)) continue;
    if (isAllowedExactEnvKey(name, selectedNames)) selected.push([name, value]);
  }
  return Object.fromEntries(selected);
}
