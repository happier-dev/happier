import { resolveFirstPartyInstallHomeDir } from '../firstPartyRuntime/installLayout.js';
import { FIRST_PARTY_MANAGED_TOOLS_DIR_NAME } from '../firstPartyRuntime/installLayoutContract.js';
import { joinPathForPathShape } from '../path/pathShape.js';

/** Install-layout input shared by installation, detection and Agent launch. */
export function resolveManagedToolsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return joinPathForPathShape(resolveFirstPartyInstallHomeDir(env), FIRST_PARTY_MANAGED_TOOLS_DIR_NAME);
}
