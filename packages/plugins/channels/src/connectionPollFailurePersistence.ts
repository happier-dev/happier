import type { JsonValue } from '@happier-dev/plugin-sdk';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';
import type { ConversationProviderFailureReasonV1 } from '@happier-dev/channels-protocol/v1';

import { ConversationConnectionPollFailureJsonSchema } from './collections.js';
import type {
  ConversationConnectionPollFailureEvidenceV1,
  ConversationConnectionPollFailureV1,
} from './connectionLifecycle.js';

type JsonRecord = Readonly<Record<string, JsonValue>>;

const validatesConversationConnectionPollFailure = compilePluginJsonSchema(
  ConversationConnectionPollFailureJsonSchema,
);

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(record: JsonRecord, key: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * This decodes only the already schema-validated discriminated shape. Bounds,
 * nullability, evidence limits, and closed objects stay with the Collection
 * schema and the generic Plugin JSON-schema validator.
 */
function decodeValidatedConversationConnectionPollFailure(
  value: JsonValue,
): ConversationConnectionPollFailureV1 | null | undefined {
  if (value === null) return null;
  if (!isJsonRecord(value)) return undefined;

  const phase = own(value, 'phase');
  const attemptCount = own(value, 'attemptCount');
  const retryNotBeforeMs = own(value, 'retryNotBeforeMs');
  const evidence = own(value, 'evidence');
  if (!isJsonRecord(evidence) || typeof attemptCount !== 'number') return undefined;

  const evidenceKind = own(evidence, 'kind');
  let decodedEvidence: ConversationConnectionPollFailureEvidenceV1 | undefined;
  if (evidenceKind === 'provider') {
    const reason = own(evidence, 'reason');
    const diagnostic = own(evidence, 'diagnostic');
    if (typeof reason !== 'string' || (diagnostic !== undefined && typeof diagnostic !== 'string')) {
      return undefined;
    }
    decodedEvidence = {
      kind: 'provider',
      reason: reason as ConversationProviderFailureReasonV1,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  } else if (evidenceKind === 'action') {
    const code = own(evidence, 'code');
    const message = own(evidence, 'message');
    if (typeof code !== 'string' || typeof message !== 'string') return undefined;
    decodedEvidence = { kind: 'action', code, message };
  }
  if (decodedEvidence === undefined) return undefined;

  if (phase === 'retryDue' && typeof retryNotBeforeMs === 'number') {
    return {
      phase,
      attemptCount: attemptCount as 1 | 2 | 3 | 4,
      retryNotBeforeMs,
      evidence: decodedEvidence,
    };
  }
  if (phase === 'blocked' && retryNotBeforeMs === null) {
    return {
      phase,
      attemptCount: attemptCount as 1 | 2 | 3 | 4 | 5,
      retryNotBeforeMs: null,
      evidence: decodedEvidence,
    };
  }
  return undefined;
}

/**
 * The one parser for the actual persisted `payload.pollFailure` value.
 * Collection admission and every durable reader use the same strict manifest
 * schema, so malformed rows fail closed instead of being reclassified by a
 * local lifecycle consumer.
 */
export function readPersistedConversationConnectionPollFailure(
  value: JsonValue | undefined,
): ConversationConnectionPollFailureV1 | null | undefined {
  if (value === undefined
    || !isValidPluginJsonSchemaValue(validatesConversationConnectionPollFailure, value)) {
    return undefined;
  }
  return decodeValidatedConversationConnectionPollFailure(value);
}
