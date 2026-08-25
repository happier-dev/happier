import type { JsonValue } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';

import { ConversationConnectionPollFailureJsonSchema } from './collections.js';
import {
  projectConversationConnectionPollFailureAttention,
  readConversationConnectionPollFailureAttention,
} from './connectionPollFailure.js';
import {
  MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS,
  isConversationPollFailureAttemptCount,
  isConversationPollRetryAttemptCount,
} from './connectionPollFailureBounds.js';
import { readPersistedConversationConnectionPollFailure } from './connectionPollFailurePersistence.js';

const validatesPersistedPollFailure = compilePluginJsonSchema(
  ConversationConnectionPollFailureJsonSchema,
);

describe('Conversation connection poll-failure codec', () => {
  it('derives retry eligibility and terminal validity from one exhaustion ceiling', () => {
    const lastRetryAttempt = MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS - 1;

    expect(isConversationPollFailureAttemptCount(lastRetryAttempt)).toBe(true);
    expect(isConversationPollRetryAttemptCount(lastRetryAttempt)).toBe(true);
    expect(isConversationPollFailureAttemptCount(MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS)).toBe(true);
    expect(isConversationPollRetryAttemptCount(MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS)).toBe(false);
    expect(isConversationPollFailureAttemptCount(MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS + 1)).toBe(false);
  });

  it('accepts exactly the Collection manifest union at the persisted-value seam', () => {
    const accepted = [
      null,
      {
        phase: 'retryDue',
        attemptCount: MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS - 1,
        retryNotBeforeMs: 0,
        evidence: { kind: 'provider', reason: 'network', diagnostic: 'provider unavailable' },
      },
      {
        phase: 'blocked',
        attemptCount: MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS,
        retryNotBeforeMs: null,
        evidence: { kind: 'action', code: 'poll_failed', message: 'Provider poll failed.' },
      },
    ] as const;
    const rejected: readonly (JsonValue | undefined)[] = [
      undefined,
      {
        phase: 'retryDue',
        attemptCount: MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS,
        retryNotBeforeMs: 0,
        evidence: { kind: 'provider', reason: 'network' },
      },
      {
        phase: 'blocked',
        attemptCount: MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS + 1,
        retryNotBeforeMs: null,
        evidence: { kind: 'provider', reason: 'network' },
      },
      {
        phase: 'blocked',
        attemptCount: 1,
        retryNotBeforeMs: null,
        evidence: { kind: 'action', code: 'poll_failed', message: 'Provider poll failed.' },
        stale: true,
      },
      {
        phase: 'blocked',
        attemptCount: 1,
        retryNotBeforeMs: null,
        evidence: { kind: 'provider', reason: 'network', diagnostic: 'd'.repeat(1_025) },
      },
      {
        phase: 'blocked',
        attemptCount: 1,
        retryNotBeforeMs: null,
        evidence: { kind: 'action', code: 'c'.repeat(257), message: 'Provider poll failed.' },
      },
    ];

    for (const value of accepted) {
      expect(isValidPluginJsonSchemaValue(validatesPersistedPollFailure, value)).toBe(true);
      expect(readPersistedConversationConnectionPollFailure(value)).not.toBeUndefined();
    }
    for (const value of rejected) {
      expect(isValidPluginJsonSchemaValue(validatesPersistedPollFailure, value)).toBe(false);
      expect(readPersistedConversationConnectionPollFailure(value)).toBeUndefined();
    }
  });

  it('redacts private evidence once for the Resource/UI projection', () => {
    const persisted = readPersistedConversationConnectionPollFailure({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: {
        kind: 'provider',
        reason: 'credentialInvalid',
        diagnostic: 'credential revoked by provider',
      },
    });
    if (persisted === null || persisted === undefined) throw new Error('Expected valid persisted poll failure.');

    const attention = projectConversationConnectionPollFailureAttention(persisted);
    expect(attention).toEqual({
      phase: 'blocked',
      attemptCount: 1,
      retryNotBeforeMs: null,
      evidence: { kind: 'provider', reason: 'credentialInvalid' },
    });
    expect(readConversationConnectionPollFailureAttention(attention)).toEqual(attention);
    expect(readConversationConnectionPollFailureAttention({
      ...attention,
      phase: 'retryDue',
      attemptCount: MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS,
      retryNotBeforeMs: 0,
    })).toBeUndefined();
    expect(readConversationConnectionPollFailureAttention({
      ...attention,
      attemptCount: MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS + 1,
    })).toBeUndefined();
  });
});
