import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';
import { createBestEffortConnectedServicesMaterialization } from '@/daemon/connectedServices/materialization/materializer';
import { requireConnectedServiceTokenCredentialRecord } from '../../../daemon/connectedServices/shared/connectedServiceCredentialRecord';
import { resolveConnectedServiceHomeDir } from '../../../daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

import { materializeCodexConnectedServiceAuth } from './materializeCodexConnectedServiceAuth';

export const createCodexConnectedServicesMaterializer = (): ConnectedServicesMaterializer => {
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
      return createBestEffortConnectedServicesMaterialization({ rootDir: stableRootDir, env: materialized.env });
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
