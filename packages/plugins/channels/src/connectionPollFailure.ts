import {
  CONVERSATION_PROVIDER_FAILURE_REASONS_V1,
  type ConversationProviderFailureReasonV1,
} from '@happier-dev/channels-protocol/v1';

import type { ConversationConnectionPollFailureV1 } from './connectionLifecycle.js';
import {
  isConversationPollFailureAttemptCount,
  isConversationPollRetryAttemptCount,
  type ConversationPollFailureAttemptCountV1,
  type ConversationPollRetryAttemptCountV1,
} from './connectionPollFailureBounds.js';

type JsonRecord = Readonly<Record<string, unknown>>;

/**
 * The safe Resource/UI representation of a persisted poll failure. It omits
 * provider diagnostics and Action messages, which are retained only in the
 * connection lifecycle record.
 */
type ConversationConnectionPollFailureAttentionEvidenceV1 =
  | Readonly<{ kind: 'provider'; reason: ConversationProviderFailureReasonV1 }>
  | Readonly<{ kind: 'action'; code: string }>;

export type ConversationConnectionPollFailureAttentionV1 =
  | Readonly<{
    phase: 'retryDue';
    attemptCount: ConversationPollRetryAttemptCountV1;
    retryNotBeforeMs: number;
    evidence: ConversationConnectionPollFailureAttentionEvidenceV1;
  }>
  | Readonly<{
    phase: 'blocked';
    attemptCount: ConversationPollFailureAttemptCountV1;
    retryNotBeforeMs: null;
    evidence: ConversationConnectionPollFailureAttentionEvidenceV1;
  }>;

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function own(record: JsonRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Redacts lifecycle-private evidence at the one management projection seam. */
export function projectConversationConnectionPollFailureAttention(
  value: ConversationConnectionPollFailureV1 | null,
): ConversationConnectionPollFailureAttentionV1 | null {
  if (value === null) return null;
  const evidence: ConversationConnectionPollFailureAttentionEvidenceV1 = value.evidence.kind === 'provider'
    ? { kind: 'provider', reason: value.evidence.reason }
    : { kind: 'action', code: value.evidence.code };
  return value.phase === 'retryDue'
    ? {
      phase: 'retryDue',
      attemptCount: value.attemptCount,
      retryNotBeforeMs: value.retryNotBeforeMs,
      evidence,
    }
    : {
      phase: 'blocked',
      attemptCount: value.attemptCount,
      retryNotBeforeMs: null,
      evidence,
    };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isProviderFailureReason(value: unknown): value is ConversationProviderFailureReasonV1 {
  return typeof value === 'string'
    && (CONVERSATION_PROVIDER_FAILURE_REASONS_V1 as readonly string[]).includes(value);
}

/**
 * Parses the distinct redacted Resource projection. It deliberately cannot
 * receive raw diagnostics or Action messages, but keeps phase/count/due
 * interpretation centralized with the persisted-value codec.
 */
export function readConversationConnectionPollFailureAttention(
  value: unknown,
): ConversationConnectionPollFailureAttentionV1 | null | undefined {
  if (value === null) return null;
  if (!isJsonRecord(value)) return undefined;
  const evidence = own(value, 'evidence');
  if (!isJsonRecord(evidence)) return undefined;
  const evidenceKind = own(evidence, 'kind');
  const parsedEvidence = evidenceKind === 'provider'
    ? (() => {
      const reason = own(evidence, 'reason');
      return isProviderFailureReason(reason) ? { kind: 'provider' as const, reason } : undefined;
    })()
    : evidenceKind === 'action'
      ? (() => {
        const code = own(evidence, 'code');
        return typeof code === 'string' && code.length > 0 ? { kind: 'action' as const, code } : undefined;
      })()
      : undefined;
  if (parsedEvidence === undefined) return undefined;

  const phase = own(value, 'phase');
  const attemptCount = own(value, 'attemptCount');
  const retryNotBeforeMs = own(value, 'retryNotBeforeMs');
  if (phase === 'retryDue'
    && isConversationPollRetryAttemptCount(attemptCount)
    && isNonNegativeSafeInteger(retryNotBeforeMs)) {
    return {
      phase,
      attemptCount,
      retryNotBeforeMs,
      evidence: parsedEvidence,
    };
  }
  if (phase === 'blocked'
    && isConversationPollFailureAttemptCount(attemptCount)
    && retryNotBeforeMs === null) {
    return {
      phase,
      attemptCount,
      retryNotBeforeMs: null,
      evidence: parsedEvidence,
    };
  }
  return undefined;
}
