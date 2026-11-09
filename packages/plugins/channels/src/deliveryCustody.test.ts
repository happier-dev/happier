import { describe, expect, it } from 'vitest';
import { MAX_CONVERSATION_RECEIVE_WAIT_MS, type ConversationDeliveryResultV1 } from '@happier-dev/channels-protocol/v1';

import {
  createReadyConversationDeliveryCustody,
  deriveConversationDeliveryProjection,
  isConversationDeliveryContentFree,
  isConversationDeliveryRetentionEligible,
  resolveConversationDeliveryCustody,
  settleConversationDeliveryAttempt,
  settleConversationDeliveryForConnectionDeletion,
  startConversationDeliveryAttempt,
  settleConversationDeliveryBeforeProviderEffect,
} from './deliveryCustody.js';

describe('Channels outward delivery custody', () => {
  it('merges no-effect outcomes and resolves ambiguity without losing accepted-start binding work', () => {
    const attempt = { state: 'attempting' as const, attemptCount: 1, attemptId: 'claimed', providerMessageIds: [] };
    expect(settleConversationDeliveryAttempt({ custody: attempt, attemptId: 'claimed', now: 10,
      result: { kind: 'notDelivered', retry: 'never' } }))
      .toMatchObject({ kind: 'settled', custody: { state: 'notSent', reason: 'providerRefused' } });
    expect(settleConversationDeliveryAttempt({ custody: attempt, attemptId: 'claimed', now: 10,
      result: { kind: 'endpointArchived', recovery: 'ownerMustUnarchiveOrRebind' } }))
      .toMatchObject({ kind: 'settled', custody: { state: 'notSent', reason: 'ownerMustUnarchiveOrRebind' } });
    for (const resolution of ['accepted', 'discarded'] as const) {
      const resolved = resolveConversationDeliveryCustody({ custody: { state: 'outcomeUnknown', attemptCount: 1,
        providerMessageIds: [], threadBindingPending: true }, resolution });
      expect(resolved).toMatchObject({ kind: 'resolved', custody: { state: 'resolved', outcome: resolution,
        threadBindingPending: resolution === 'accepted' } });
      if (resolved.kind !== 'resolved') throw new Error('Expected resolution');
      expect(deriveConversationDeliveryProjection(resolved.custody)).toEqual({
        attention: false, terminal: resolution !== 'accepted',
      });
    }
  });
  it('settles typed unsupported delivery as permanent no-effect custody with owner attention', () => {
    const settled = settleConversationDeliveryAttempt({
      custody: { state: 'attempting', attemptCount: 1, attemptId: 'unsupported-start',
        providerMessageIds: [], threadBindingPending: true },
      attemptId: 'unsupported-start', now: 2, result: { kind: 'notReady', reason: 'unsupported' },
    });
    expect(settled).toMatchObject({ kind: 'settled', custody: { state: 'notSent', reason: 'providerRefused', providerMessageIds: [] } });
    if (settled.kind !== 'settled') throw new Error('Expected settlement');
    expect(deriveConversationDeliveryProjection(settled.custody)).toEqual({ terminal: true, attention: true });
    expect(startConversationDeliveryAttempt({ custody: settled.custody, attemptId: 'resend', startedAt: 3 }))
      .toEqual({ kind: 'notStartable', reason: 'notDue' });
  });
  it('keeps a delivered start recoverable until its ordinary child binding is recorded, without resending', () => {
    const endpoint = { kind: 'thread', audience: 'shared', id: 'thread-1', parentId: 'mailbox' } as const;
    const started = startConversationDeliveryAttempt({
      custody: { ...createReadyConversationDeliveryCustody(), threadBindingPending: true },
      attemptId: 'start', startedAt: 1,
    });
    if (started.kind !== 'started') throw new Error('Expected start');
    const settled = settleConversationDeliveryAttempt({
      custody: started.custody, attemptId: 'start', now: 2,
      result: { kind: 'delivered', providerMessageIds: ['message'], endpoint },
    });
    if (settled.kind !== 'settled') throw new Error('Expected settlement');
    expect(settled.custody).toMatchObject({ endpoint, threadBindingPending: true });
    expect(deriveConversationDeliveryProjection(settled.custody).terminal).toBe(false);
    expect(isConversationDeliveryRetentionEligible(settled.custody)).toBe(false);
    expect(startConversationDeliveryAttempt({ custody: settled.custody, attemptId: 'resend', startedAt: 3 }))
      .toEqual({ kind: 'notStartable', reason: 'notDue' });
  });
  it('honors positive provider Retry-After for a sixth no-effect retry without owner attention', () => {
    const result = settleConversationDeliveryAttempt({
      custody: { state: 'attempting', attemptCount: 5, attemptId: 'attempt-5',  providerMessageIds: [] },
      attemptId: 'attempt-5',
      result: { kind: 'notDelivered', retry: 'after', retryAfterMs: 120_000 },
      now: 100,
    });
    expect(result).toMatchObject({ kind: 'settled', custody: { state: 'retryDue', retryNotBefore: 120_100 } });
    if (result.kind !== 'settled') throw new Error('Expected settlement');
    expect(deriveConversationDeliveryProjection(result.custody)).toMatchObject({ terminal: false, attention: false });
    expect(startConversationDeliveryAttempt({ custody: result.custody, attemptId: 'attempt-6', startedAt: 120_100 }))
      .toMatchObject({ kind: 'started', custody: { attemptCount: 6 } });
  });
  it.each(['safe', 'zeroRetryAfter'] as const)('bounds %s no-effect backoff and never starts before the due time', (retryPolicy) => {
    let custody = createReadyConversationDeliveryCustody();
    let now = 0;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const started = startConversationDeliveryAttempt({ custody, attemptId: `attempt-${attempt}`, startedAt: now });
      expect(started.kind).toBe('started');
      if (started.kind !== 'started') throw new Error('Expected retry to start');
      const settled = settleConversationDeliveryAttempt({
        custody: started.custody, attemptId: `attempt-${attempt}`, now,
        result: retryPolicy === 'safe'
          ? { kind: 'notDelivered', retry: 'safe' }
          : { kind: 'notDelivered', retry: 'after', retryAfterMs: 0 },
      });
      if (settled.kind !== 'settled') throw new Error('Expected retry settlement');
      custody = settled.custody;
      const due = now + Math.min(MAX_CONVERSATION_RECEIVE_WAIT_MS, 1_000 * 2 ** (attempt - 1));
      expect(custody).toMatchObject({ state: 'retryDue', retryNotBefore: due });
      expect(deriveConversationDeliveryProjection(custody)).toMatchObject({ terminal: false, attention: false });
      expect(startConversationDeliveryAttempt({ custody, attemptId: 'early', startedAt: due - 1 }))
        .toEqual({ kind: 'notStartable', reason: 'notDue' });
      now = due;
    }
    const terminalResults = [
      { kind: 'delivered', providerMessageIds: ['accepted'] },
      { kind: 'partial', providerMessageIds: ['accepted'], failedChunk: 1 },
      { kind: 'outcomeUnknown' },
    ] satisfies readonly ConversationDeliveryResultV1[];
    for (const result of terminalResults) {
      const acceptedAttempt = startConversationDeliveryAttempt({
        custody: createReadyConversationDeliveryCustody(), attemptId: 'effect', startedAt: now,
      });
      if (acceptedAttempt.kind !== 'started') throw new Error('Expected effect attempt');
      const terminal = settleConversationDeliveryAttempt({
        custody: acceptedAttempt.custody, attemptId: 'effect', now, result,
      });
      if (terminal.kind !== 'settled') throw new Error('Expected effect settlement');
      expect(startConversationDeliveryAttempt({ custody: terminal.custody, attemptId: 'resend', startedAt: now }))
        .toEqual({ kind: 'notStartable', reason: 'notDue' });
    }
  });
  it('keeps interrupted delivery unknown when the retired attempt later completes', () => {
    const unknown = {
      state: 'outcomeUnknown' as const,
      attemptCount: 1,
      attemptId: 'delivery-attempt-1',

      providerMessageIds: [],
    };

    expect(settleConversationDeliveryAttempt({ custody: unknown, attemptId: 'other-attempt',
      result: { kind: 'delivered', providerMessageIds: ['receipt'] }, now: 30_101 }))
      .toEqual({ kind: 'staleAttempt' });
    expect(settleConversationDeliveryAttempt({ custody: unknown, attemptId: 'delivery-attempt-1',
      result: { kind: 'delivered', providerMessageIds: ['receipt'] }, now: 30_101 }))
      .toEqual({ kind: 'staleAttempt' });
  });

  it('settles a pre-I/O currentness mismatch as terminal no-attention suppression', () => {
    const started = startConversationDeliveryAttempt({
      custody: createReadyConversationDeliveryCustody(),
      attemptId: 'attempt-1',
      startedAt: 100,
    });
    if (started.kind !== 'started') throw new Error('Expected the attempt to start.');

    const suppressed = settleConversationDeliveryBeforeProviderEffect({
      custody: started.custody,
      attemptId: 'attempt-1',
      reason: 'policySuppressed',
    });
    expect(suppressed).toEqual({
      kind: 'settled',
      custody: {
        state: 'notSent',
        reason: 'policySuppressed',
        attemptCount: 1,
        providerMessageIds: [],
      },
    });
    if (suppressed.kind !== 'settled') throw new Error('Expected suppression settlement.');
    expect(deriveConversationDeliveryProjection(suppressed.custody)).toEqual({
      terminal: true,
      attention: false,
    });
    expect(isConversationDeliveryRetentionEligible(suppressed.custody)).toBe(true);
  });

  it('allows exactly one current attempt to cross the provider boundary', () => {
    const ready = createReadyConversationDeliveryCustody();
    const started = startConversationDeliveryAttempt({
      custody: ready,
      attemptId: 'attempt-1',
      startedAt: 100,
    });

    expect(started).toEqual({
      kind: 'started',
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'attempt-1',

        providerMessageIds: [],
      },
    });
    if (started.kind !== 'started') throw new Error('Expected the first attempt to start.');

    expect(startConversationDeliveryAttempt({
      custody: started.custody,
      attemptId: 'attempt-2',
      startedAt: 101,
    })).toEqual({ kind: 'notStartable', reason: 'attemptInProgress' });
    expect(settleConversationDeliveryAttempt({
      custody: started.custody,
      attemptId: 'retired-attempt',
      result: { kind: 'delivered', providerMessageIds: ['message-1'] },
      now: 102,
    })).toEqual({ kind: 'staleAttempt' });
  });

  it('keeps archive-specific recovery distinct from generic known-no-effect delivery', () => {
    const started = startConversationDeliveryAttempt({
      custody: createReadyConversationDeliveryCustody(),
      attemptId: 'attempt-1',
      startedAt: 100,
    });
    if (started.kind !== 'started') throw new Error('Expected the first attempt to start.');

    const settled = settleConversationDeliveryAttempt({
      custody: started.custody,
      attemptId: 'attempt-1',
      result: { kind: 'endpointArchived', recovery: 'unarchiveAndRetry' },
      now: 101,
    });

    expect(settled).toEqual({
      kind: 'settled',
      custody: {
        state: 'notSent',
        reason: 'ownerMustUnarchiveOrRebind',
        attemptCount: 1,
        providerMessageIds: [],
      },
    });
    if (settled.kind !== 'settled') throw new Error('Expected archive recovery to settle.');
    expect(deriveConversationDeliveryProjection(settled.custody)).toEqual({
      terminal: true,
      attention: true,
    });
    expect(startConversationDeliveryAttempt({ custody: settled.custody, attemptId: 'retry', startedAt: 102 }))
      .toEqual({ kind: 'notStartable', reason: 'notDue' });
  });

  it('persists growing fallback retry-not-before without a positive provider wait while preserving positive hints', () => {
    const initialAttempt = startConversationDeliveryAttempt({
      custody: createReadyConversationDeliveryCustody(),
      attemptId: 'attempt-1',
      startedAt: 100,
    });
    if (initialAttempt.kind !== 'started') throw new Error('Expected the initial attempt to start.');

    const retryDue = settleConversationDeliveryAttempt({
      custody: initialAttempt.custody,
      attemptId: 'attempt-1',
      result: { kind: 'notDelivered', retry: 'safe' },
      now: 100,
    });
    if (retryDue.kind !== 'settled') throw new Error('Expected a retryable known-no-effect result.');

    expect(retryDue.custody).toEqual({
      state: 'retryDue',
      attemptCount: 1,
      providerMessageIds: [],
      retryNotBefore: 1_100,
    });
    expect(settleConversationDeliveryAttempt({
      custody: initialAttempt.custody,
      attemptId: 'attempt-1',
      result: { kind: 'notDelivered', retry: 'after', retryAfterMs: 0 },
      now: 100,
    })).toMatchObject({
      kind: 'settled',
      custody: { state: 'retryDue', retryNotBefore: 1_100 },
    });

    expect(startConversationDeliveryAttempt({
      custody: retryDue.custody,
      attemptId: 'attempt-too-early',
      startedAt: 1_099,
    })).toEqual({ kind: 'notStartable', reason: 'notDue' });
    expect(startConversationDeliveryAttempt({
      custody: retryDue.custody,
      attemptId: 'attempt-at-due-time',
      startedAt: 1_100,
    })).toMatchObject({
      kind: 'started',
      custody: { state: 'attempting', attemptCount: 2, attemptId: 'attempt-at-due-time' },
    });

    expect(settleConversationDeliveryAttempt({
      custody: {
        state: 'attempting',
        attemptCount: 4,
        attemptId: 'attempt-4',

        providerMessageIds: [],
      },
      attemptId: 'attempt-4',
      result: { kind: 'notDelivered', retry: 'safe' },
      now: 100,
    })).toEqual({
      kind: 'settled',
      custody: {
        state: 'retryDue',
        attemptCount: 4,
        providerMessageIds: [],
        retryNotBefore: 8_100,
      },
    });
  });

  it('allows later projection after a partial effect while retaining it for owner resolution', () => {
    const started = startConversationDeliveryAttempt({
      custody: createReadyConversationDeliveryCustody(),
      attemptId: 'attempt-1',
      startedAt: 100,
    });
    if (started.kind !== 'started') throw new Error('Expected the first attempt to start.');
    const partial = settleConversationDeliveryAttempt({
      custody: started.custody,
      attemptId: 'attempt-1',
      result: {
        kind: 'partial',
        providerMessageIds: ['message-1'],
        failedChunk: 1,
      },
      now: 101,
    });
    if (partial.kind !== 'settled') throw new Error('Expected partial delivery to settle.');

    expect(deriveConversationDeliveryProjection(partial.custody)).toEqual({
      terminal: true,
      attention: true,
    });
    expect(isConversationDeliveryRetentionEligible(partial.custody)).toBe(false);
    expect(resolveConversationDeliveryCustody({
      custody: partial.custody,
      resolution: 'accepted',
    })).toEqual({
      kind: 'resolved',
      custody: {
        state: 'resolved',
        outcome: 'accepted',
        attemptCount: 1,
        providerMessageIds: ['message-1'],
        failedChunk: 1,
      },
    });
  });

  it('settles only provably no-effect custody during connection deletion', () => {
    const deletedReady = settleConversationDeliveryForConnectionDeletion({
      custody: createReadyConversationDeliveryCustody(),
    });
    expect(deletedReady).toEqual({
      kind: 'connectionDeleted',
      custody: {
        state: 'notSent',
        reason: 'connectionDeleted',
        attemptCount: 0,
        providerMessageIds: [],
      },
    });
    if (deletedReady.kind !== 'connectionDeleted') throw new Error('Expected ready custody to settle for deletion.');
    expect(settleConversationDeliveryForConnectionDeletion({
      custody: deletedReady.custody,
    })).toEqual(deletedReady);
    expect(deriveConversationDeliveryProjection(deletedReady.custody)).toEqual({
      terminal: true,
      attention: false,
    });
    expect(isConversationDeliveryRetentionEligible(deletedReady.custody)).toBe(true);

    expect(settleConversationDeliveryForConnectionDeletion({
      custody: {
        state: 'retryDue',
        attemptCount: 1,
        providerMessageIds: [],
        retryNotBefore: 200,
      },
    })).toEqual({
      kind: 'connectionDeleted',
      custody: {
        state: 'notSent',
        reason: 'connectionDeleted',
        attemptCount: 1,
        providerMessageIds: [],
      },
    });
    expect(settleConversationDeliveryForConnectionDeletion({
      custody: {
        state: 'notDelivered',
        attemptCount: 1,
        providerMessageIds: [],
        archiveRecovery: 'unarchiveAndRetry' as const,
      },
    })).toEqual({
      kind: 'connectionDeleted',
      custody: {
        state: 'notSent',
        reason: 'connectionDeleted',
        attemptCount: 1,
        providerMessageIds: [],
      },
    });

    for (const custody of [
      {
        state: 'attempting' as const,
        attemptCount: 1,
        attemptId: 'attempt-1',

        providerMessageIds: [],
      },
      {
        state: 'partial' as const,
        attemptCount: 1,
        providerMessageIds: ['message-1'],
        failedChunk: 1,
      },
      {
        state: 'outcomeUnknown' as const,
        attemptCount: 1,
        providerMessageIds: [],
      },
    ]) {
      expect(settleConversationDeliveryForConnectionDeletion({ custody })).toEqual({
        kind: 'notDeletable',
        reason: 'externalEffectMayExist',
      });
    }
  });

  it('frees delivery bodies exactly where the canonical content-free predicate says no retry can consume them', () => {
    // Terminal states whose replay identity alone settles the obligation.
    for (const custody of [
      { state: 'delivered' as const, attemptCount: 1, providerMessageIds: ['message-1'] },
      { state: 'suppressed' as const, attemptCount: 1, providerMessageIds: [] },
      { state: 'connectionDeleted' as const, attemptCount: 1, providerMessageIds: [] },
      { state: 'resolvedAccepted' as const, attemptCount: 1, providerMessageIds: ['message-1'] },
      // Terminal not-delivered attention, including the archive arm no owner
      // retry can consume: compaction keeps the attention evidence in the
      // state itself and frees only the body.
      { state: 'notDelivered' as const, attemptCount: 3, providerMessageIds: [] },
      {
        state: 'notDelivered' as const,
        attemptCount: 1,
        providerMessageIds: [],
        archiveRecovery: 'ownerMustUnarchiveOrRebind' as const,
      },
      { state: 'partial' as const, attemptCount: 1, providerMessageIds: ['message-1'], failedChunk: 1 },
      { state: 'outcomeUnknown' as const, attemptCount: 1, providerMessageIds: [] },
    ]) {
      expect(isConversationDeliveryContentFree(custody)).toBe(true);
    }

    // Bodies that live work or owner-led retry still needs.
    for (const custody of [
      createReadyConversationDeliveryCustody(),
      { state: 'retryDue' as const, attemptCount: 1, providerMessageIds: [], retryNotBefore: 200 },
      {
        state: 'attempting' as const,
        attemptCount: 1,
        attemptId: 'attempt-1',

        providerMessageIds: [],
      },
    ]) {
      expect(isConversationDeliveryContentFree(custody)).toBe(false);
    }

    // Content-freedom is deliberately narrower than retention: the
    // unarchive-and-retry row still expires with its row after the recovery
    // window, but until then its body is the owner's retry input.
    const recoverable = {
      state: 'notDelivered' as const,
      attemptCount: 1,
      providerMessageIds: [],
      archiveRecovery: 'unarchiveAndRetry',
    } as const;
    expect(isConversationDeliveryRetentionEligible(recoverable)).toBe(true);
    expect(isConversationDeliveryContentFree(recoverable)).toBe(true);
    expect(isConversationDeliveryRetentionEligible({
      state: 'partial',
      attemptCount: 1,
      providerMessageIds: ['message-1'],
      failedChunk: 1,
    })).toBe(false);
  });
});
