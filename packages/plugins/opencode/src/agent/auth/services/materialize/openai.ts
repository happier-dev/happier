import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import {
  brokerProvider,
  directApiKeyProvider,
  type OpenCodeAuthMaterializationAccumulator,
} from './accumulator.js';

/**
 * Materialize the OpenAI auth surface for OpenCode.
 *
 * - OpenAI Codex subscription (OAuth) is BROKERED: a stable non-refreshable marker is written and the
 *   Happier broker fetches fresh access tokens from the daemon bridge (no refresh token ever reaches
 *   OpenCode). The built-in Codex loader bails on the non-oauth marker; the broker loader engages.
 * - A direct OpenAI platform API key is used as a real `{type:'api', key}` entry.
 */
export function materializeOpenAiAuth(
  accumulator: OpenCodeAuthMaterializationAccumulator,
  input: Readonly<{
    openaiCodex?: ConnectedServiceCredentialRecordV1 | null;
    openai?: ConnectedServiceCredentialRecordV1 | null;
    connectedServiceGroupIdsByServiceId?: Readonly<Record<string, string>> | null;
  }>,
): void {
  const groupIds = input.connectedServiceGroupIdsByServiceId ?? null;
  if (input.openaiCodex) {
    brokerProvider(accumulator, 'openai', 'openai-codex', input.openaiCodex, groupIds?.['openai-codex'] ?? null);
  } else if (input.openai) {
    directApiKeyProvider(accumulator, 'openai', 'openai', input.openai, groupIds?.['openai'] ?? null);
  }
}
