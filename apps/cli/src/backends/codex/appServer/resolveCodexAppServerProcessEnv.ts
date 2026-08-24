import { readSessionMetadataRuntimeDescriptor } from '@happier-dev/agents';

import { resolveConfiguredCodexSqliteHome } from '@/backends/codex/connectedServices/codexStateFileNames';
import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

export type CodexRuntimeHomeAffinity = Readonly<{
  home: 'user' | 'connectedService' | null;
  homePath: string | null;
  sqliteHomePath?: string | null;
}>;

export async function resolveCodexAppServerProcessEnv(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  affinity?: CodexRuntimeHomeAffinity | null;
}>): Promise<NodeJS.ProcessEnv> {
  const processEnv = params.processEnv ?? process.env;
  const homePath = params.affinity?.homePath?.trim() ?? '';
  if (!homePath) return processEnv;

  const persistedSqliteHomePath = params.affinity?.sqliteHomePath?.trim() ?? '';
  let sqliteHomePath = persistedSqliteHomePath;
  if (!sqliteHomePath) {
    if (params.affinity?.home === 'connectedService') {
      const manifest = await readConnectedServiceStateSharingManifest(homePath);
      sqliteHomePath = manifest.effectiveStateMode === 'shared'
        ? resolveConfiguredCodexSqliteHome(processEnv)
        : homePath;
    } else {
      sqliteHomePath = typeof processEnv.CODEX_SQLITE_HOME === 'string' && processEnv.CODEX_SQLITE_HOME.trim()
        ? resolveConfiguredCodexSqliteHome(processEnv)
        : homePath;
    }
  }

  return {
    ...processEnv,
    CODEX_HOME: homePath,
    CODEX_SQLITE_HOME: sqliteHomePath,
  };
}

export async function resolveCodexAppServerProcessEnvFromMetadata(params: Readonly<{
  processEnv?: NodeJS.ProcessEnv;
  metadata?: unknown;
}>): Promise<NodeJS.ProcessEnv> {
  return await resolveCodexAppServerProcessEnv({
    processEnv: params.processEnv,
    affinity: readSessionMetadataRuntimeDescriptor(params.metadata, 'codex'),
  });
}
