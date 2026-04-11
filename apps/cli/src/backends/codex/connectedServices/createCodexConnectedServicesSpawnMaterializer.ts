import type { ConnectedServicesSpawnMaterializer } from '@/backends/connectedServices/spawnMaterializer';
import { requireConnectedServiceTokenCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import { resolveConnectedServiceHomeDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

import { materializeCodexConnectedServiceAuth } from './materializeCodexConnectedServiceAuth';

export const createCodexConnectedServicesSpawnMaterializer = (): ConnectedServicesSpawnMaterializer => {
  return async ({ activeServerDir, recordsByServiceId }) => {
    const codex = recordsByServiceId.get('openai-codex') ?? null;
    const openai = recordsByServiceId.get('openai') ?? null;

    if (codex) {
      const stableRootDir = resolveConnectedServiceHomeDir({
        activeServerDir,
        serviceId: codex.serviceId,
        profileId: codex.profileId,
        agentId: 'codex',
      });
      const materialized = await materializeCodexConnectedServiceAuth({ rootDir: stableRootDir, record: codex });
      return { env: materialized.env, cleanupOnFailure: null, cleanupOnExit: null };
    }

    if (!openai) return null;

    const token = requireConnectedServiceTokenCredentialRecord(openai);
    return {
      env: { OPENAI_API_KEY: token.token.token },
      cleanupOnFailure: null,
      cleanupOnExit: null,
    };
  };
};
