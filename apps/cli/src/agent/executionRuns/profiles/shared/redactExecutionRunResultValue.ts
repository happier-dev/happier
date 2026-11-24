import type { ExecutionRunProfileResultContract, JsonValue } from '@happier-dev/protocol';

import { redactTranscriptSecrets } from '@/api/session/client/transport/transcriptSecretRedaction';

/** String values the result schema itself declares (`enum`, `const`) belong to the person, not the Agent. */
function readDeclaredStrings(schema: unknown, declared: Set<string>): Set<string> {
  if (Array.isArray(schema)) {
    for (const entry of schema) readDeclaredStrings(entry, declared);
  } else if (schema !== null && typeof schema === 'object') {
    for (const [keyword, value] of Object.entries(schema)) {
      if (keyword === 'enum' && Array.isArray(value)) {
        for (const choice of value) if (typeof choice === 'string') declared.add(choice);
      } else if (keyword === 'const' && typeof value === 'string') {
        declared.add(value);
      } else {
        readDeclaredStrings(value, declared);
      }
    }
  }
  return declared;
}

function redactUndeclaredStrings(value: JsonValue, declared: ReadonlySet<string>): JsonValue {
  if (typeof value === 'string') return declared.has(value) ? value : redactTranscriptSecrets(value);
  if (Array.isArray(value)) return value.map(entry => redactUndeclaredStrings(entry, declared));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactUndeclaredStrings(entry, declared)]));
}

/**
 * Masks the Agent-authored strings of a result its contract already decoded and validated. A value
 * the contract declares (a decision, or a JSON schema `enum`/`const` choice) stays exact so later
 * conditions compare it with the person's literal; a decision's reason and every other JSON string
 * are Agent content. Keys, numbers and booleans stay exact.
 */
export function redactExecutionRunResultValue(
  value: JsonValue | string,
  contract: ExecutionRunProfileResultContract | undefined,
): JsonValue | string {
  if (contract?.kind === 'json') return redactUndeclaredStrings(value, readDeclaredStrings(contract.schema, new Set()));
  if (contract?.kind !== 'decision') return redactTranscriptSecrets(value);
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'reason' in value
    ? { ...value, reason: redactTranscriptSecrets(value.reason) }
    : value;
}
