import { join } from 'node:path';

export function resolveHappyHomeDirFromEnvironment(processEnv: NodeJS.ProcessEnv = process.env): string {
  const override = typeof processEnv.HAPPIER_HOME_DIR === 'string' ? processEnv.HAPPIER_HOME_DIR.trim() : '';
  if (override) return override;
  return join(processEnv.HOME ?? processEnv.USERPROFILE ?? '', '.happier');
}
