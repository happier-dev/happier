import { join } from 'node:path';

import type { AccountSettings, ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { syncCodexConnectedServiceHome } from './syncCodexConnectedServiceHome';
import { writeCodexAuthStoreFile } from './writeCodexAuthStoreFile';

export async function materializeCodexConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  record: ConnectedServiceCredentialRecordV1;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{
  env: Record<string, string>;
  targetMaterializedRoot: string;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}>> {
  const codexHome = join(params.rootDir, 'codex-home');
  const syncResult = await syncCodexConnectedServiceHome({
    destinationCodexHome: codexHome,
    accountSettings: params.accountSettings ?? null,
    processEnv: params.processEnv ?? process.env,
  });
  await writeCodexAuthStoreFile({ codexHome, record: params.record });
  return {
    targetMaterializedRoot: params.rootDir,
    env: {
      CODEX_HOME: codexHome,
      CODEX_SQLITE_HOME: syncResult.targetSqliteHome,
    },
    ...(syncResult.diagnostics.length > 0 ? { diagnostics: syncResult.diagnostics } : {}),
  };
}
