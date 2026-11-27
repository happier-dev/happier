import { describe, expect, it, vi } from 'vitest';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { runTriageAttention } from '../attention/runtime.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { REVIEW_DESCRIPTOR_V1 } from './contribution.js';
import { readReviewAttentionV1 } from './source.js';
import type { TriageReadAttentionInputV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

type Notice = Parameters<PluginInvocationContext['services']['notifications']['send']>[0];

describe('Review attention invalidation', () => {
  it('updates the same notice from requested verdict to pending decision to settled', async () => {
    vi.useFakeTimers();
    const { watchableCollections } = createTestkitCorpusCollections();
    const listeners = new Map<string, (event: { payload: unknown }) => Promise<void>>();
    const calls: string[] = [];
    const notices: Notice[] = [];
    const requester = { actorKind: 'person', accountId: 'd71dfd69-e2d9-4f92-8453-d4fd74f8f2b1' } as const;
    let requestedBy: typeof requester | undefined = requester;
    let needsYou = true;
    let requestedVerdict = true;
    const facts = () => ({ reviewId: 'review-a', roundOrdinal: 1, reason: 'review_needs_you' as const,
      needsYou, requestedVerdict, pendingDecisions: needsYou && !requestedVerdict, canSubmitVerdict: true });
    const controller = new AbortController();
    const context = { signal: controller.signal, services: {
      storage: { account: { collection: () => watchableCollections.sourceInstances } },
      events: { host: { subscribe: (target: { eventId: string }, listener: (event: { payload: unknown }) => Promise<void>) => {
        listeners.set(target.eventId, listener); return { dispose() {} };
      } } },
      targetedContributions: { observeForSelf: () => ({ readCurrent: async () => ({ contributions: [{
        contributor: { pluginId: 'happier.triage', contributionId: 'reviews' },
        descriptor: REVIEW_DESCRIPTOR_V1, operations: { readAttention: { role: 'readAttention' } },
      }] }), dispose() {} }) },
      actions: {
        // Admission and host Actions are transport boundaries; the real source
        // derives both initial and invalidated attention from Review owner facts.
        executeAdmittedTargetedOperation: async (_operation: unknown, input: TriageReadAttentionInputV1) => {
          calls.push('list'); return readReviewAttentionV1(input, context);
        },
        execute: async (id: string, input: { reviewId: string }) => {
          if (id === 'artifact.list') return { items: [{ artifactId: 'review-a',
            ownerAccountId: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e',
            header: { v: 1, kind: 'review.v1', reviewId: 'review-a', title: 'Review title',
              ...(requestedBy ? { requestedBy } : {}) },
          }] };
          if (id === 'reviews.list') return { items: [{ reviewId: 'review-a', subjectKind: 'comparison', needsYou: facts() }], cursor: null };
          calls.push(`${id}:${input.reviewId}`);
          return { review: { reviewId: input.reviewId, subjectKind: 'comparison' }, human: { needsYou: facts() } };
        },
      }, notifications: { send: async (notice: Notice) => {
        notices.push(notice); return { deliveries: [], replayed: false };
      } }, logger: { warn() {} },
    } } as unknown as BackgroundServiceContext;
    const running = runTriageAttention(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['list']);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ type: 'decision', resolved: false, title: 'Review title',
        reviewAttention: { requestedVerdict: true, subjectKind: 'comparison', requestedBy: requester } });
      await listeners.get('@happier/account/entities-invalidated')?.({ payload: { entityIds: ['unrelated'] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['list']);
      expect(notices).toHaveLength(1);
      requestedVerdict = false;
      await listeners.get('@happier/account/entities-invalidated')?.({ payload: { entityIds: ['review-a'], reviewIds: ['review-a'] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(notices).toHaveLength(2);
      expect(notices[1]).toMatchObject({ itemId: notices[0]?.itemId, page: notices[0]?.page,
        type: 'decision', resolved: false, reviewAttention: { requestedVerdict: false, subjectKind: 'comparison', requestedBy: requester } });
      requestedBy = undefined;
      await listeners.get('@happier/account/entities-invalidated')?.({ payload: { entityIds: ['review-a'], reviewIds: ['review-a'] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(notices).toHaveLength(3);
      expect(notices[2]).toMatchObject({ itemId: notices[0]?.itemId, resolved: false,
        reviewAttention: { requestedVerdict: false, subjectKind: 'comparison' } });
      expect(notices[2]?.reviewAttention).not.toHaveProperty('requestedBy');
      needsYou = false;
      await listeners.get('@happier/account/entities-invalidated')?.({ payload: { entityIds: ['review-a'], reviewIds: ['review-a'] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['list', 'review.get:review-a', 'review.get:review-a', 'review.get:review-a']);
      expect(notices).toHaveLength(4);
      expect(notices[3]).toMatchObject({ itemId: notices[0]?.itemId, page: notices[0]?.page,
        type: 'decision', resolved: true });
      expect(notices[3]).not.toHaveProperty('reviewAttention');
      await listeners.get('@happier/automation/event-sources-invalidated')?.({ payload: { reason: 'reconnect' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['list', 'review.get:review-a', 'review.get:review-a', 'review.get:review-a', 'list']);
      expect(notices.at(-1)).toMatchObject({ itemId: notices[0]?.itemId, resolved: true });
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });
});
