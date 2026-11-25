import { describe, expect, it } from 'vitest';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import {
  reviewTriageLocalRefV1, TriageGetResultV1Schema,
  TriageReadAttentionResultV1Schema, TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createRegisteredReviewSourceTestkit } from './attention.testkit.js';

const instance = { v: 1, instance: { source: { pluginId: 'happier.triage', localId: 'reviews' },
  sourceInstanceId: 'f2494c84-85b6-4c0c-a99a-9a36765ed07e' }, binding: { purpose: 'reviews', source: 'accountData' },
  localInstanceKey: 'reviews', configuration: { v: 1, token: 'happier-reviews-v1' } };

describe('registered Review source', () => {
  it('coalesces requested verdicts and pending findings under one reason, retires it and renews it next round', async () => {
    let roundOrdinal = 1;
    let requestedVerdict = true;
    let pendingDecisions = true;
    const calls: string[] = [];
    // Opened Artifact transport is the boundary; the real Action executor keeps
    // kind admission in this source-to-recipient read path.
    const artifactExecutor = createActionExecutor({ artifactAction: async () => ({ items: [{
      artifactId: 'review', header: { kind: 'review.v1', v: 1, reviewId: 'review', title: 'Recipient-opened title' },
      headerVersion: 1,
      ownerAccountId: 'owner', access: 'view', publicAudience: 'none', seq: 1, createdAt: 1, updatedAt: 2,
    }] }) });
    // Host Actions are the process boundary: permission and needs-you facts are
    // supplied by the Review owner, while the recipient Artifact opener owns title decryption.
    const review = () => ({ reviewId: 'review', createdAt: 1, updatedAt: 2,
      projectSourceId: null, workflowId: null, subjectKind: 'comparison', sourceKind: 'direct', state: 'completed',
      currentRoundOrdinal: roundOrdinal, startedAt: 1, finishedAt: 2, counts: { total: 2, needsDecision: pendingDecisions ? 2 : 0 } });
    const needsYou = () => ({ reviewId: 'review', roundOrdinal, reason: 'review_needs_you',
      needsYou: requestedVerdict || pendingDecisions, requestedVerdict, pendingDecisions, canSubmitVerdict: true });
    const actions = { execute: async (id: string) => {
      calls.push(id);
      if (id === 'reviews.list') return { items: [{ ...review(), needsYou: needsYou() }], cursor: null };
      if (id === 'review.get') return { review: review(), human: { needsYou: needsYou() } };
      if (id === 'artifact.list') {
        const result = await artifactExecutor.execute('artifact.list', { artifactIds: ['review'] }, { surface: 'ui' });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        return result.result;
      }
      throw new Error(`Unexpected host Action ${id}`);
    } } as unknown as PluginServices['actions'];
    const kit = await createRegisteredReviewSourceTestkit(actions);
    const read = async () => TriageReadAttentionResultV1Schema.parse(await kit.invokeAction('test-read', { v: 1, instance }));
    try {
      const pending = await read();
      expect(pending).toMatchObject({ kind: 'page', nextPage: false, items: [{
        localRef: { kindId: 'review', collisionScope: 'reviews', entryId: 'review' },
        reason: 'review_needs_you', resolved: false, title: 'Recipient-opened title', type: 'decision',
        reviewAttention: { requestedVerdict: true, subjectKind: 'comparison' } }] });
      requestedVerdict = false;
      expect(await read()).toMatchObject({ items: [{ reason: 'review_needs_you', resolved: false,
        reviewAttention: { requestedVerdict: false, subjectKind: 'comparison' } }] });
      pendingDecisions = false;
      expect(await read()).toMatchObject({ items: [{ reason: 'review_needs_you', resolved: true }] });
      roundOrdinal = 2; requestedVerdict = true;
      expect(await read()).toMatchObject({ items: [{ reason: 'review_needs_you', resolved: false,
        reviewAttention: { requestedVerdict: true, subjectKind: 'comparison' } }] });
      expect(calls.filter(id => id === 'review.get')).toHaveLength(0);
      expect(calls.filter(id => id === 'reviews.list')).toHaveLength(4);

      const readRowSnapshots = async () => {
        const scan = TriageScanResultV1Schema.parse(await kit.invokeAction('test-scan', {
          v: 1, instance, page: { kind: 'initial', limit: 2 },
        }));
        const get = TriageGetResultV1Schema.parse(await kit.invokeAction('test-get', {
          v: 1, instance, localRef: reviewTriageLocalRefV1('review'),
        }));
        if (scan.kind !== 'complete' || scan.observations[0]?.kind !== 'present' || get.kind !== 'present') {
          throw new Error('Expected a Review row from scan and get');
        }
        return [scan.observations[0].snapshot, get.snapshot];
      };
      roundOrdinal = 1;
      for (const row of await readRowSnapshots()) {
        expect(row.title).toBe('Recipient-opened title');
        expect(row.designation).toBeUndefined();
      }
      roundOrdinal = 2;
      for (const row of await readRowSnapshots()) {
        expect(row).toMatchObject({ title: 'Recipient-opened title', designation: 'Round 2' });
      }
    } finally { await kit.dispose(); }
  });
});
