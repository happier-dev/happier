import { resolveFirstPartyInstallHomeDir } from '../firstPartyRuntime/installLayout.js';
import { joinPathForPathShape } from '../path/pathShape.js';

/** Install-layout input shared by installation, detection and Agent launch. */
export function resolveManagedToolsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return joinPathForPathShape(resolveFirstPartyInstallHomeDir(env), 'tools');
}
