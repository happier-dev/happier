import type { ConnectedServicesSpawnMaterializer } from '@/backends/connectedServices/spawnMaterializer';
import { createBestEffortCleanupDirectory } from '@/backends/connectedServices/spawnMaterializer';

import { materializePiConnectedServiceAuth } from './materializePiConnectedServiceAuth';

export const createPiConnectedServicesSpawnMaterializer = (): ConnectedServicesSpawnMaterializer => {
  return async ({ rootDir, recordsByServiceId }) => {
    const openaiCodex = recordsByServiceId.get('openai-codex') ?? null;
    const openai = recordsByServiceId.get('openai') ?? null;
    const claudeSubscription = recordsByServiceId.get('claude-subscription') ?? null;
    const anthropic = recordsByServiceId.get('anthropic') ?? null;
    if (!openaiCodex && !openai && !anthropic && !claudeSubscription) return null;

    const cleanupRoot = createBestEffortCleanupDirectory(rootDir);
    const materialized = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex,
      openai,
      claudeSubscription,
      anthropic,
    });
    return {
      env: materialized.env,
      cleanupOnFailure: cleanupRoot,
      cleanupOnExit: cleanupRoot,
    };
  };
};
