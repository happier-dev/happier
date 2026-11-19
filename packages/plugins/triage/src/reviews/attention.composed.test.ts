import { describe, expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import { TriageReadAttentionInputV1Schema, TriageReadAttentionResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_ACCOUNT_ACTIONS } from '../accountDefinition.js';
import { PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { createReviewSourceContributionV1 } from './contribution.js';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

// Keep the registered source's real declaration and Action handler, without
// importing unrelated collection schemas through the full plugin definition.
let kit: PluginTestkit;
const source = definePlugin({ id: 'happier.triage', version: '0.0.0',
contributionPoints: PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS,
contributesTo: { 'happier.triage': { sources: { reviews: createReviewSourceContributionV1() } } },
actions: { ...Object.fromEntries(
  Object.entries(TRIAGE_ACCOUNT_ACTIONS).filter(([id]) => id.startsWith('internal/reviews/')),
), 'test-read': { title: 'Read admitted Review attention', surfaces: ['cli'], dangerLevel: 'safe',
  inputSchema: TriageReadAttentionInputV1Schema, resultSchema: TriageReadAttentionResultV1Schema,
  run: async (input, context) => context.services.actions.executeAdmittedTargetedOperation(
    kit.issueAdmittedTargetedOperation({ point: TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
      contributor: { testkit: kit, contributionId: 'reviews' }, role: 'readAttention' }), input),
} } });

const instance = { v: 1, instance: { source: { pluginId: 'happier.triage', localId: 'reviews' },
  sourceInstanceId: 'f2494c84-85b6-4c0c-a99a-9a36765ed07e' }, binding: { purpose: 'reviews', source: 'accountData' },
  localInstanceKey: 'reviews', configuration: { v: 1, token: 'happier-reviews-v1' } };

describe('registered Review attention source', () => {
  it('coalesces requested verdicts and pending findings under one reason, retires it and renews it next round', async () => {
    let roundOrdinal = 1;
    let requestedVerdict = true;
    let pendingDecisions = true;
    const calls: string[] = [];
    // Opened Artifact transport is the boundary; the real Action executor keeps
    // kind admission in this source-to-recipient read path.
    const artifactExecutor = createActionExecutor({ artifactAction: async () => ({ artifact: {
      artifactId: 'review', header: { kind: 'review.v1', v: 1, reviewId: 'review', title: 'Recipient-opened title' },
      body: JSON.stringify({ v: 1, rounds: [] }), revision: { headerVersion: 1, bodyVersion: 1 },
      ownerAccountId: 'owner', access: 'view', publicAudience: 'none', seq: 1, createdAt: 1, updatedAt: 2,
    } }) });
    // Host Actions are the process boundary: permission and needs-you facts are
    // supplied by the Review owner, while the recipient Artifact opener owns title decryption.
    const actions = { execute: async (id: string) => {
      calls.push(id);
      if (id === 'reviews.list') return { items: [{ reviewId: 'review', createdAt: 1, updatedAt: 2,
        projectSourceId: null, workflowId: null, subjectKind: 'comparison', sourceKind: 'direct', state: 'completed',
        currentRoundOrdinal: roundOrdinal, startedAt: 1, finishedAt: 2, counts: { total: 2, needsDecision: pendingDecisions ? 2 : 0 },
        needsYou: { reviewId: 'review', roundOrdinal, reason: 'review_needs_you', needsYou: requestedVerdict || pendingDecisions,
          requestedVerdict, pendingDecisions, canSubmitVerdict: true } }], cursor: null };
      if (id === 'artifact.get') {
        const result = await artifactExecutor.execute('artifact.get', { artifactId: 'review' }, { surface: 'ui' });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        return result.result;
      }
      throw new Error(`Unexpected host Action ${id}`);
    } } as unknown as PluginServices['actions'];
    kit = await createPluginTestkit({ manifest: source.manifest, module: source, services: { actions } });
    const read = async () => TriageReadAttentionResultV1Schema.parse(await kit.invokeAction('test-read', { v: 1, instance }));
    try {
      const pending = await read();
      expect(pending).toMatchObject({ kind: 'page', nextPage: false, items: [{
        localRef: { kindId: 'review', collisionScope: 'reviews', entryId: 'review' },
        reason: 'review_needs_you', resolved: false, title: 'Recipient-opened title', type: 'decision' }] });
      requestedVerdict = false;
      expect(await read()).toMatchObject({ items: [{ reason: 'review_needs_you', resolved: false }] });
      pendingDecisions = false;
      expect(await read()).toMatchObject({ items: [{ reason: 'review_needs_you', resolved: true }] });
      roundOrdinal = 2; requestedVerdict = true;
      expect(await read()).toMatchObject({ items: [{ reason: 'review_needs_you', resolved: false }] });
      expect(calls.filter(id => id === 'review.get')).toHaveLength(0);
      expect(calls.filter(id => id === 'reviews.list')).toHaveLength(4);
    } finally { await kit.dispose(); }
  });
});
