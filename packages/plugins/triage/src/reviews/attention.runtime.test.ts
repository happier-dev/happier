import { describe, expect, it, vi } from 'vitest';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { runTriageAttention } from '../attention/runtime.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { REVIEW_DESCRIPTOR_V1 } from './contribution.js';

describe('Review attention invalidation', () => {
  it('reads only hinted Reviews, ignores unrelated entities, and rescans on reconnect', async () => {
    vi.useFakeTimers();
    const { watchableCollections } = createTestkitCorpusCollections();
    const listeners = new Map<string, (event: { payload: unknown }) => Promise<void>>();
    const calls: string[] = [];
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
        executeAdmittedTargetedOperation: async () => { calls.push('list'); return { kind: 'page', items: [], nextPage: false }; },
        execute: async (id: string, input: { reviewId: string }) => {
          if (id === 'artifact.get') return { artifact: { header: { title: 'Review title' } } };
          calls.push(`${id}:${input.reviewId}`);
          return { review: { reviewId: input.reviewId }, human: { needsYou: {
            reviewId: input.reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: false,
            requestedVerdict: false, pendingDecisions: false, canSubmitVerdict: false,
          } } };
        },
      }, notifications: { send: async () => ({ deliveries: [], replayed: false }) }, logger: { warn() {} },
    } } as unknown as BackgroundServiceContext;
    const running = runTriageAttention(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['list']);
      await listeners.get('@happier/account/entities-invalidated')?.({ payload: { entityIds: ['unrelated'] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['list']);
      await listeners.get('@happier/account/entities-invalidated')?.({ payload: { entityIds: ['review-a'], reviewIds: ['review-a'] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['list', 'review.get:review-a']);
      await listeners.get('@happier/automation/event-sources-invalidated')?.({ payload: { reason: 'reconnect' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual(['list', 'review.get:review-a', 'list']);
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });
});
