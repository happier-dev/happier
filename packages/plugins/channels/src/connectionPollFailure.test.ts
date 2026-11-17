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
import { readPersistedConversationConnectionPollFailure } from './connectionPollFailurePersistence.js';

const validatesPersistedPollFailure = compilePluginJsonSchema(
  ConversationConnectionPollFailureJsonSchema,
);
const validAttemptCounts = [1, 5, 6, Number.MAX_SAFE_INTEGER];
const invalidAttemptCounts = [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1];

describe('Conversation connection poll-failure codec', () => {
  it('accepts exactly the Collection manifest union at the persisted-value seam', () => {
    const accepted = [
      null,
      ...validAttemptCounts.map(attemptCount => ({
        phase: 'retryDue' as const,
        attemptCount,
        retryNotBeforeMs: 0,
        evidence: { kind: 'provider' as const, reason: 'network' as const, diagnostic: 'provider unavailable' },
      })),
      {
        phase: 'blocked',
        attemptCount: 7,
        retryNotBeforeMs: null,
        evidence: { kind: 'action', code: 'poll_failed', message: 'Provider poll failed.' },
      },
    ] as const;
    const rejected: readonly (JsonValue | undefined)[] = [
      undefined,
      ...invalidAttemptCounts.map(attemptCount => ({
        phase: 'retryDue',
        attemptCount,
        retryNotBeforeMs: 0,
        evidence: { kind: 'provider', reason: 'network' },
      })),
      {
        phase: 'blocked',
        attemptCount: Number.MAX_SAFE_INTEGER + 1,
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
      expect(readPersistedConversationConnectionPollFailure(value)).toEqual(value);
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
    // This reader has no Collection admission ahead of it to reject bad counts.
    for (const attemptCount of validAttemptCounts) {
      expect(readConversationConnectionPollFailureAttention({
        ...attention, phase: 'retryDue', attemptCount, retryNotBeforeMs: 0,
      })).toMatchObject({ phase: 'retryDue', attemptCount });
    }
    for (const attemptCount of invalidAttemptCounts) {
      expect(readConversationConnectionPollFailureAttention({ ...attention, attemptCount })).toBeUndefined();
    }
  });

  it('re-redacts historical Action messages while retaining actionable text and code-only readers', () => {
    const persisted = readPersistedConversationConnectionPollFailure({
      phase: 'blocked', attemptCount: 1, retryNotBeforeMs: null,
      evidence: { kind: 'action', code: 'external_poll_refused',
        message: 'Reconnect the provider. client_secret=historical-secret; path=C:\\private\\poll-canary',
      },
    });
    if (!persisted) throw new Error('Expected a valid retained poll failure.');
    const attention = projectConversationConnectionPollFailureAttention(persisted);
    expect(attention).toMatchObject({ evidence: { message: expect.stringContaining('Reconnect the provider.') } });
    expect(JSON.stringify(attention)).not.toContain('historical-secret');
    expect(JSON.stringify(attention)).not.toContain('poll-canary');
    expect(readConversationConnectionPollFailureAttention(attention)).toEqual(attention);
    expect(readConversationConnectionPollFailureAttention({ ...attention,
      evidence: { kind: 'action', code: 'external_poll_refused' },
    })).toMatchObject({ evidence: { kind: 'action', code: 'external_poll_refused' } });
    expect(readConversationConnectionPollFailureAttention({ ...attention,
      evidence: { kind: 'action', code: 'external_poll_refused', message: 42 },
    })).toBeUndefined();
  });
});
