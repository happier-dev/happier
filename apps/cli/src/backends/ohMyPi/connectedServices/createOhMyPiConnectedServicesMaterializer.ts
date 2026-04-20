import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';

import { materializeOhMyPiConnectedServiceAuth } from './materializeOhMyPiConnectedServiceAuth';

export const createOhMyPiConnectedServicesMaterializer = (): ConnectedServicesMaterializer => {
  return async ({ recordsByServiceId }) => {
    const openaiCodex = recordsByServiceId.get('openai-codex') ?? null;
    const openai = recordsByServiceId.get('openai') ?? null;
    const claudeSubscription = recordsByServiceId.get('claude-subscription') ?? null;
    const anthropic = recordsByServiceId.get('anthropic') ?? null;
    const gemini = recordsByServiceId.get('gemini') ?? null;
    if (!openaiCodex && !openai && !claudeSubscription && !anthropic && !gemini) return null;

    return {
      ...(await materializeOhMyPiConnectedServiceAuth({
        openaiCodex,
        openai,
        claudeSubscription,
        anthropic,
        gemini,
      })),
      cleanupOnFailure: null,
      cleanupOnExit: null,
    };
  };
};
