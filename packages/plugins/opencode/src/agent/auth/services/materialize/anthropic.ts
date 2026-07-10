import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import {
  brokerProvider,
  directApiKeyProvider,
  type OpenCodeAuthMaterializationAccumulator,
} from './accumulator.js';

/**
 * Materialize the Anthropic auth surface for OpenCode.
 *
 * - Claude subscription (setup-token OR browser-login OAuth) is BROKERED (Bearer + `anthropic-beta`
 *   per OQ-1): a stable non-refreshable marker is written and the Happier broker fetches fresh access
 *   tokens from the daemon bridge (no refresh token ever reaches OpenCode). Both setup-token and
 *   OAuth credential kinds route through the broker, so OpenCode never holds the Claude refresh token.
 * - A direct Anthropic Console API key is used as a real `{type:'api', key}` entry (x-api-key).
 */
export function materializeAnthropicAuth(
  accumulator: OpenCodeAuthMaterializationAccumulator,
  input: Readonly<{
    claudeSubscription?: ConnectedServiceCredentialRecordV1 | null;
    anthropic?: ConnectedServiceCredentialRecordV1 | null;
    connectedServiceGroupIdsByServiceId?: Readonly<Record<string, string>> | null;
  }>,
): void {
  const groupIds = input.connectedServiceGroupIdsByServiceId ?? null;
  if (input.claudeSubscription) {
    brokerProvider(accumulator, 'anthropic', 'claude-subscription', input.claudeSubscription, groupIds?.['claude-subscription'] ?? null);
  } else if (input.anthropic) {
    directApiKeyProvider(accumulator, 'anthropic', 'anthropic', input.anthropic, groupIds?.['anthropic'] ?? null);
  }
}
