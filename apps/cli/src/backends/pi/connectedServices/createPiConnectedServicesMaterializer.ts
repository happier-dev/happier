import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';
import { createBestEffortConnectedServicesMaterialization } from '@/daemon/connectedServices/materialization/materializer';

import { materializePiConnectedServiceAuth } from './materializePiConnectedServiceAuth';

export const createPiConnectedServicesMaterializer = (): ConnectedServicesMaterializer => {
  return async ({ rootDir, recordsByServiceId }) => {
    const openaiCodex = recordsByServiceId.get('openai-codex') ?? null;
    const openai = recordsByServiceId.get('openai') ?? null;
    const claudeSubscription = recordsByServiceId.get('claude-subscription') ?? null;
    const anthropic = recordsByServiceId.get('anthropic') ?? null;
    if (!openaiCodex && !openai && !anthropic && !claudeSubscription) return null;

    const materialized = await materializePiConnectedServiceAuth({
      rootDir,
      openaiCodex,
      openai,
      claudeSubscription,
      anthropic,
    });
    return createBestEffortConnectedServicesMaterialization({ rootDir, env: materialized.env });
  };
};
