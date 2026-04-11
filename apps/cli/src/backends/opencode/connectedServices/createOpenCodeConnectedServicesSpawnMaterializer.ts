import type { ConnectedServicesSpawnMaterializer } from '@/backends/connectedServices/spawnMaterializer';
import { createBestEffortCleanupDirectory } from '@/backends/connectedServices/spawnMaterializer';

import { materializeOpenCodeConnectedServiceAuth } from './materializeOpenCodeConnectedServiceAuth';

export const createOpenCodeConnectedServicesSpawnMaterializer = (): ConnectedServicesSpawnMaterializer => {
  return async ({ rootDir, recordsByServiceId }) => {
    const openaiCodex = recordsByServiceId.get('openai-codex') ?? null;
    const openai = recordsByServiceId.get('openai') ?? null;
    const anthropic = recordsByServiceId.get('anthropic') ?? null;
    if (!openaiCodex && !openai && !anthropic) return null;

    const cleanupRoot = createBestEffortCleanupDirectory(rootDir);
    const materialized = await materializeOpenCodeConnectedServiceAuth({
      rootDir,
      openaiCodex,
      openai,
      anthropic,
    });
    return {
      env: materialized.env,
      cleanupOnFailure: cleanupRoot,
      cleanupOnExit: cleanupRoot,
    };
  };
};
