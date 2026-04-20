import type { ConnectedServicesMaterializer } from '@/daemon/connectedServices/materialization/materializer';

import { materializeClaudeConnectedServiceAuth } from './materializeClaudeConnectedServiceAuth';
import { materializeClaudeSubscriptionConnectedServiceAuth } from './materializeClaudeSubscriptionConnectedServiceAuth';

export const createClaudeConnectedServicesMaterializer = (): ConnectedServicesMaterializer => {
  return async ({ recordsByServiceId }) => {
    const claudeSubscription = recordsByServiceId.get('claude-subscription') ?? null;
    const anthropic = recordsByServiceId.get('anthropic') ?? null;

    if (claudeSubscription) {
      return {
        env: materializeClaudeSubscriptionConnectedServiceAuth({ record: claudeSubscription }).env,
        cleanupOnFailure: null,
        cleanupOnExit: null,
      };
    }

    if (!anthropic) return null;

    return {
      env: materializeClaudeConnectedServiceAuth({ record: anthropic }).env,
      cleanupOnFailure: null,
      cleanupOnExit: null,
    };
  };
};
