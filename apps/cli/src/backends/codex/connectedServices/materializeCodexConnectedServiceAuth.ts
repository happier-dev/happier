import { join } from 'node:path';

import type { AccountSettings, ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { CONNECTED_SERVICE_MATERIALIZATION_REASONS, type ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { syncCodexConnectedServiceHome } from './syncCodexConnectedServiceHome';
import { writeCodexAuthStoreFile } from './writeCodexAuthStoreFile';

export async function materializeCodexConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  activeServerDir?: string;
  vendorResumeId?: string | null;
  previousCodexHome?: string | null;
  record: ConnectedServiceCredentialRecordV1;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
  sessionStateMode?: 'existing';
  validateCurrentBeforeMutation?: () => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
}>): Promise<Readonly<{
  env: Record<string, string>;
  targetMaterializedRoot: string;
  diagnostics?: readonly ConnectedServicesMaterializationDiagnostic[];
}>> {
  const codexHome = join(params.rootDir, 'codex-home');
  const syncResult = params.sessionStateMode === 'existing'
    ? { targetSqliteHome: codexHome, diagnostics: [] }
    : await syncCodexConnectedServiceHome({
    destinationCodexHome: codexHome,
    activeServerDir: params.activeServerDir,
    vendorResumeId: params.vendorResumeId,
    previousCodexHome: params.previousCodexHome ?? null,
    accountSettings: params.accountSettings ?? null,
    processEnv: params.processEnv ?? process.env,
  });
  const current = await writeCodexAuthStoreFile({
    codexHome, record: params.record, validateCurrentBeforeMutation: params.validateCurrentBeforeMutation,
  });
  const diagnostics: readonly ConnectedServicesMaterializationDiagnostic[] = [
    ...syncResult.diagnostics,
    ...(!current ? [{
      code: 'codex_connected_service_generation_superseded',
      providerId: 'codex' as const,
      serviceId: 'openai-codex' as const,
      severity: 'blocking' as const,
      reason: CONNECTED_SERVICE_MATERIALIZATION_REASONS.authoritativeGroupTargetSuperseded,
    }] : []),
  ];
  return {
    targetMaterializedRoot: params.rootDir,
    env: {
      CODEX_HOME: codexHome,
      ...(syncResult.targetSqliteHome ? { CODEX_SQLITE_HOME: syncResult.targetSqliteHome } : {}),
    },
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
