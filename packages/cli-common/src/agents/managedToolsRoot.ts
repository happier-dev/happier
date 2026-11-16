import { resolveFirstPartyInstallHomeDir } from '../firstPartyRuntime/installLayout.js';
import { FIRST_PARTY_MANAGED_TOOLS_DIR_NAME, MANAGED_TOOLS_ROOT_ENV_KEY } from '../firstPartyRuntime/installLayoutContract.js';
import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveHappyHomeDirFromEnvironment } from './resolveHappyHomeDir.js';

/** Install-layout input shared by installation, detection and Agent launch. */
export function resolveManagedToolsRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = env[MANAGED_TOOLS_ROOT_ENV_KEY]?.trim();
  if (override) return resolveHappyHomeDirFromEnvironment({ ...env, HAPPIER_HOME_DIR: override });
  return joinPathForPathShape(resolveFirstPartyInstallHomeDir(env), FIRST_PARTY_MANAGED_TOOLS_DIR_NAME);
}
