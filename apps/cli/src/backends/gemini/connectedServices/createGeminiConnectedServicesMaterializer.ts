import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';
import { createRetainedConnectedServicesMaterialization } from '@/daemon/connectedServices/materialization/materializer';
import {
  resolveConnectedServiceGroupHomeDir,
  resolveConnectedServiceHomeDir,
} from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';

import { materializeGeminiConnectedServiceAuth } from './materializeGeminiConnectedServiceAuth';

export const createGeminiConnectedServicesMaterializer = (): ConnectedServicesMaterializer => {
  return async ({ activeServerDir, recordsByServiceId, selectionsByServiceId }) => {
    const selection = selectionsByServiceId?.get('gemini') ?? null;
    const gemini = selection?.record ?? recordsByServiceId.get('gemini') ?? null;
    if (!gemini) return null;

    const stableRootDir = selection?.kind === 'group'
      ? resolveConnectedServiceGroupHomeDir({
          activeServerDir,
          serviceId: selection.serviceId,
          groupId: selection.groupId,
          agentId: 'gemini',
        })
      : resolveConnectedServiceHomeDir({
          activeServerDir,
          serviceId: gemini.serviceId,
          profileId: selection?.kind === 'profile' ? selection.profileId : gemini.profileId,
          agentId: 'gemini',
        });

    const materialized = await materializeGeminiConnectedServiceAuth({ rootDir: stableRootDir, record: gemini });
    return createRetainedConnectedServicesMaterialization({
      rootDir: stableRootDir,
      env: materialized.env,
    });
  };
};
