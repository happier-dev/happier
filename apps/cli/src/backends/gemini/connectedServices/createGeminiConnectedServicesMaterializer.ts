import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';
import { createBestEffortConnectedServicesMaterialization } from '@/daemon/connectedServices/materialization/materializer';

import { materializeGeminiConnectedServiceAuth } from './materializeGeminiConnectedServiceAuth';

export const createGeminiConnectedServicesMaterializer = (): ConnectedServicesMaterializer => {
  return async ({ rootDir, recordsByServiceId }) => {
    const gemini = recordsByServiceId.get('gemini') ?? null;
    if (!gemini) return null;

    const materialized = await materializeGeminiConnectedServiceAuth({ rootDir, record: gemini });
    return createBestEffortConnectedServicesMaterialization({ rootDir, env: materialized.env });
  };
};
