import { describe, expect, it } from 'vitest';

import {
  claimStaleConversationDeliveryAttemptRecovery,
  createReadyConversationDeliveryCustody,
  deriveConversationDeliveryProjection,
  isConversationDeliveryContentFree,
  isConversationDeliveryRetentionEligible,
  resolveConversationDeliveryCustody,
  retryConversationDeliveryAfterArchiveRecovery,
  settleConversationDeliveryAttempt,
  settleConversationDeliveryForConnectionDeletion,
  startConversationDeliveryAttempt,
  suppressConversationDeliveryAttempt,
} from './deliveryCustody.js';

describe('Channels outward delivery custody', () => {
  it('reclaims only a stale attempting custody with a new CAS-fenced reconciliation attempt identity', () => {
    const attempting = {
      state: 'attempting' as const,
      attemptCount: 1,
      attemptId: 'delivery-attempt-1',
      startedAt: 100,
      providerMessageIds: [],
    };

    expect(claimStaleConversationDeliveryAttemptRecovery({
      custody: attempting,
      recoveryAttemptId: 'reconcile-attempt-1',
      recoveredAt: 129,
      staleAfterMs: 30,
    })).toEqual({ kind: 'notRecoverable', reason: 'attemptStillCurrent' });
    expect(claimStaleConversationDeliveryAttemptRecovery({
      custody: attempting,
      recoveryAttemptId: 'reconcile-attempt-1',
      recoveredAt: 130,
      staleAfterMs: 30,
    })).toEqual({
      kind: 'reclaimed',
      custody: {
        state: 'attempting',
        attemptCount: 1,
        attemptId: 'reconcile-attempt-1',
        startedAt: 130,
        providerMessageIds: [],
      },
    });
    expect(claimStaleConversationDeliveryAttemptRecovery({
      custody: createReadyConversationDeliveryCustody(),
      recoveryAttemptId: 'reconcile-attempt-2',
      recoveredAt: 130,
      staleAfterMs: 30,
    })).toEqual({ kind: 'notRecoverable', reason: 'notAttempting' });
  });

  it('settles a pre-I/O currentness mismatch as terminal no-attention suppression', () => {
    const started = startConversationDeliveryAttempt({
      custody: createReadyConversationDeliveryCustody(),
      attemptId: 'attempt-1',
      startedAt: 100,
    });
    if (started.kind !== 'started') throw new Error('Expected the attempt to start.');

    const suppressed = suppressConversationDeliveryAttempt({
      custody: started.custody,
      attemptId: 'attempt-1',
    });
    expect(suppressed).toEqual({
      kind: 'settled',
      custody: {
        state: 'suppressed',
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
        startedAt: 100,
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
        state: 'notDelivered',
        attemptCount: 1,
        providerMessageIds: [],
        archiveRecovery: 'unarchiveAndRetry',
      },
    });
    if (settled.kind !== 'settled') throw new Error('Expected archive recovery to settle.');
    expect(deriveConversationDeliveryProjection(settled.custody)).toEqual({
      terminal: true,
      attention: true,
    });
    expect(retryConversationDeliveryAfterArchiveRecovery({
      custody: settled.custody,
    })).toEqual({
      kind: 'retryReady',
      custody: {
        state: 'ready',
        attemptCount: 0,
        providerMessageIds: [],
      },
    });
    expect(retryConversationDeliveryAfterArchiveRecovery({
      custody: {
        state: 'notDelivered',
        attemptCount: 1,
        providerMessageIds: [],
        archiveRecovery: 'ownerMustUnarchiveOrRebind',
      },
    })).toEqual({ kind: 'notRetryable' });
  });

  it('persists a bounded fallback retry-not-before when a safe provider result has no hint while preserving explicit hints', () => {
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
      custody: { state: 'retryDue', retryNotBefore: 100 },
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
        startedAt: 100,
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
        retrySafe: false,
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
        state: 'resolvedAccepted',
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
        state: 'connectionDeleted',
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
        state: 'connectionDeleted',
        attemptCount: 1,
        providerMessageIds: [],
      },
    });
    expect(settleConversationDeliveryForConnectionDeletion({
      custody: {
        state: 'notDelivered',
        attemptCount: 1,
        providerMessageIds: [],
        archiveRecovery: 'unarchiveAndRetry',
      },
    })).toEqual({
      kind: 'connectionDeleted',
      custody: {
        state: 'connectionDeleted',
        attemptCount: 1,
        providerMessageIds: [],
      },
    });

    for (const custody of [
      {
        state: 'attempting' as const,
        attemptCount: 1,
        attemptId: 'attempt-1',
        startedAt: 100,
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
        archiveRecovery: 'ownerMustUnarchiveOrRebind',
      },
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
        startedAt: 100,
        providerMessageIds: [],
      },
      { state: 'partial' as const, attemptCount: 1, providerMessageIds: ['message-1'], failedChunk: 1 },
      { state: 'outcomeUnknown' as const, attemptCount: 1, providerMessageIds: [] },
      {
        state: 'notDelivered' as const,
        attemptCount: 1,
        providerMessageIds: [],
        archiveRecovery: 'unarchiveAndRetry',
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
    expect(isConversationDeliveryContentFree(recoverable)).toBe(false);
  });
});
