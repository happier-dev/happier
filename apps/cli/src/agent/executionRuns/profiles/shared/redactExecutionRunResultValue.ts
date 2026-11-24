import type {
  ExecutionRunProfileResultContract,
  JsonValue,
} from '@happier-dev/protocol';

import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';

/**
 * Masks the Agent-authored strings of a result its contract already decoded and validated. A
 * declared decision is the contract's own value and stays exact; only its reason is prose. A JSON
 * result follows the caller's schema, so each of its string values is Agent content; keys,
 * numbers and booleans stay exact.
 */
export function redactExecutionRunResultValue(
  value: JsonValue | string,
  contract: ExecutionRunProfileResultContract | undefined,
): JsonValue | string {
  if (contract?.kind !== 'decision') return redactTranscriptSecrets(value);
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'reason' in value
    ? { ...value, reason: redactTranscriptSecrets(value.reason) }
    : value;
}
