import type { ConnectedServicesSpawnMaterializer } from '@/backends/connectedServices/spawnMaterializer';
import { createBestEffortCleanupDirectory } from '@/backends/connectedServices/spawnMaterializer';

import { materializeGeminiConnectedServiceAuth } from './materializeGeminiConnectedServiceAuth';

export const createGeminiConnectedServicesSpawnMaterializer = (): ConnectedServicesSpawnMaterializer => {
  return async ({ rootDir, recordsByServiceId }) => {
    const gemini = recordsByServiceId.get('gemini') ?? null;
    if (!gemini) return null;

    const cleanupRoot = createBestEffortCleanupDirectory(rootDir);
    const materialized = await materializeGeminiConnectedServiceAuth({ rootDir, record: gemini });
    return {
      env: materialized.env,
      cleanupOnFailure: cleanupRoot,
      cleanupOnExit: cleanupRoot,
    };
  };
};
