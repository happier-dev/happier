import { requireConnectedServiceTokenCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import { materializeCodexConnectedServiceAuth } from './materializeCodexConnectedServiceAuth';

export function createCodexConnectedServicesMaterializer(): ConnectedServicesProviderMaterializer {
  return async (params) => {
    const codex = params.recordsByServiceId.get('openai-codex') ?? null;
    const openai = params.recordsByServiceId.get('openai') ?? null;

    if (codex) {
      const materialized = await materializeCodexConnectedServiceAuth({
        rootDir: params.rootDir,
        record: codex,
        accountSettings: params.accountSettings ?? null,
        processEnv: params.processEnv ?? process.env,
      });

      return {
        env: materialized.env,
        targetMaterializedRoot: materialized.targetMaterializedRoot,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        ...(materialized.diagnostics && materialized.diagnostics.length > 0
          ? { diagnostics: materialized.diagnostics }
          : {}),
      };
    }

    if (!openai) return null;
    const token = requireConnectedServiceTokenCredentialRecord(openai);
    return { env: { OPENAI_API_KEY: token.token.token }, cleanupOnFailure: null, cleanupOnExit: null };
  };
}
