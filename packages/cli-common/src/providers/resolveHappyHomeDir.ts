import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

export function resolveHappyHomeDirFromEnvironment(processEnv: NodeJS.ProcessEnv = process.env): string {
  const override = typeof processEnv.HAPPIER_HOME_DIR === 'string' ? processEnv.HAPPIER_HOME_DIR.trim() : '';
  if (override) {
    return isAbsolute(override) ? override : resolvePath(override);
  }

  const stackOverride = typeof processEnv.HAPPIER_STACK_CLI_HOME_DIR === 'string'
    ? processEnv.HAPPIER_STACK_CLI_HOME_DIR.trim()
    : '';
  if (stackOverride) {
    return isAbsolute(stackOverride) ? stackOverride : resolvePath(stackOverride);
  }

  const envHome = (processEnv.HOME ?? processEnv.USERPROFILE ?? '').trim();
  let baseHome = envHome;
  if (!baseHome) {
    try {
      baseHome = homedir();
    } catch {
      baseHome = '';
    }
  }

  if (!baseHome) {
    baseHome = tmpdir();
  }

  return join(baseHome, '.happier');
}
