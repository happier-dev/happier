import { describe, expect, it } from 'vitest';
import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { createPullRequestReviewWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/pullRequestReview';
import { reviewReviewerIdsForStartV1, ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { SCM_HOSTING_PULL_REQUEST_LIFECYCLE_ACTIONS_V1 } from '@happier-dev/protocol/scm/pullRequestLifecycleActionsV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';
import { createTriagePullRequestReviewActionTestkit, TESTKIT_OBSERVED_REVISION } from '../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support';
import { createWorkflowCoordinator, WORKFLOW_CANCEL_REQUESTED_ABORT_REASON } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { buildWorkflowActionContext } from './workflowActionContext';

const event = { pluginId: 'example.forge', localId: 'pull-request' };
const workspace = { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' };

async function createPrWorkflow() {
  const reviews: unknown[] = [];
  const source = await createTriagePullRequestReviewActionTestkit({ executeReview: async raw => {
    reviews.push(raw);
    const input = ReviewStartInputSchema.parse(raw);
    return { intent: 'review', sessionId: input.sessionId,
      results: reviewReviewerIdsForStartV1(input).map(key => ({ key, ok: true, result: { runId: `run-${key}` } })) };
  } });
  const definitions = PLUGIN_MANIFEST.contributes.actions.map(action => ActionDefinitionV1Schema.parse({
    kindVersion: 1, id: `${PLUGIN_MANIFEST.id}/actions/${action.id}`, title: resolvePluginLocalizedStringV2Text(action.title),
    description: null, safety: action.dangerLevel === 'safe' ? 'safe' : 'danger', placements: [], slash: null, bindings: null, examples: null,
    surfaces: { agent: true }, inputHints: null, inputSchema: action.inputSchema, outputSchema: action.resultSchema,
  }));
  const list = () => definitions;
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
    invokeContributedAction: async request => ({ ok: true,
      result: await source.invoke(request.action.localId, projectNativeJsonValueForTransport(request.input)) }) });
  let workspaceReads = 0;
  const newRun = () => {
    // Production binds a coordinator store and its frontier to one Workflow Run.
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store,
      executeStep: async () => { throw new Error('Review engines belong to the Review Action'); },
      resolveWorkspace: async () => { workspaceReads++; return { ok: true, workspace }; },
      action: { executor, buildContext: async params => buildWorkflowActionContext(params),
        observeRun: async () => { throw new Error('Triage returns the admitted Review'); } } });
    return { store, coordinator };
  };
  const definition = createPullRequestReviewWorkflowV1(event);
  const { v: _version, reviewTarget, ...savedInputs } = source.savedInput;
  const inputs = Object.fromEntries(Object.entries({ ...savedInputs,
    quickReview: { reviewers: [{ kind: 'engine', engineId: 'engine-a' }], instructions: 'Quick composition' },
    standardReview: { reviewers: [{ kind: 'engine', engineId: 'engine-a' }, { kind: 'engine', engineId: 'engine-b' }], instructions: 'Standard composition' },
  }).map(([key, value]) => [key, projectNativeJsonValueForTransport(value)]));
  const admitted = async (runId: string, authorAssociation: string, headSha = TESTKIT_OBSERVED_REVISION.headSha, number = 17,
    action: typeof SCM_HOSTING_PULL_REQUEST_LIFECYCLE_ACTIONS_V1[number] = 'opened') => {
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs, machineId: workspace.machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'trigger', workDepth: 0, admitLeaf: async () => { throw new Error('No native leaf admission'); },
        eventOccurrence: { event, payload: { pullRequest: { action, authorAssociation, headSha }, reviewTarget: {
          ...reviewTarget, entryRef: { ...reviewTarget.entryRef, entryId: String(number) },
          comparisonSource: { ...reviewTarget.comparisonSource, locator: { ...reviewTarget.comparisonSource.locator, number, headOid: headSha } },
        } } } },
      effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => {
          const action = definitions.find(item => item.id === id);
          return action ? freezeWorkflowActionContractV1(action) : null;
        } } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    return { ...accepted.snapshot, runId };
  };
  return { source, reviews, ...newRun(), newRun, admitted, inputs, workspaceReads: () => workspaceReads };
}

describe('PR review automation through the workflow coordinator', () => {
  it('offers the editable PR automation through the canonical built-in catalog', () => {
    const control = resolveBuiltinWorkflowDefinitionV1('open-a-pull-request');
    expect(validateWorkflowDefinition(control?.definition).issues).toEqual([]);
    const recipe = resolveBuiltinWorkflowDefinitionV1('review-pull-request');
    expect(recipe).not.toBeNull();
    expect(validateWorkflowDefinition(recipe?.definition).issues).toEqual([]);
  });

  it.each(['external', 'unknown'])('holds %s authors before all source/workspace effects, then reviews Standard after ordinary approval', async association => {
    const h = await createPrWorkflow();
    const run = await h.admitted(`pr-${association}`, association, TESTKIT_OBSERVED_REVISION.headSha, 17,
      association === 'external' ? 'reopened' : 'opened');
    expect(await h.coordinator.run(run)).toMatchObject({ state: 'waiting_for_review' });
    expect(h.source.events).toEqual([]);
    expect(h.workspaceReads()).toBe(0);
    expect(h.reviews).toEqual([]);
    const hold = h.store.list().find(row => row.blockId === 'approve-pr-setup');
    if (!hold) throw new Error('Missing ordinary workflow hold');
    await h.store.commitFact({ key: hold.key, lifecycle: 'completed' });
    const continued = await h.coordinator.run(run);
    expect(continued, JSON.stringify(h.store.list().map(({ blockId, lifecycle, reason }) => ({ blockId, lifecycle, reason })))).toMatchObject({ state: 'succeeded' });
    expect(h.source.prepareInputs).toHaveLength(1);
    expect(h.reviews).toEqual([expect.objectContaining({ instructions: 'Standard composition',
      reviewers: [{ kind: 'engine', engineId: 'engine-a' }, { kind: 'engine', engineId: 'engine-b' }] })]);
  });

  it('stops a refused external-author hold without any preparation or review effects', async () => {
    const h = await createPrWorkflow();
    const run = await h.admitted('denied-external', 'external');
    expect(await h.coordinator.run(run)).toMatchObject({ state: 'waiting_for_review' });
    const cancelled = new AbortController();
    cancelled.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    expect(await h.coordinator.run({ ...run, signal: cancelled.signal })).toMatchObject({ state: 'cancelled' });
    expect(h.source.events).toEqual([]);
    expect(h.workspaceReads()).toBe(0);
    expect(h.reviews).toEqual([]);
  });

  it.each(['closed', 'merged'] as const)('finishes a %s occurrence before approval or preparation effects', async action => {
    const h = await createPrWorkflow();
    const run = await h.admitted(`terminal-${action}`, 'unknown', TESTKIT_OBSERVED_REVISION.headSha, 17, action);
    expect(await h.coordinator.run(run)).toMatchObject({ state: 'succeeded' });
    expect(h.store.list().some(row => row.blockId === 'approve-pr-setup')).toBe(false);
    expect(h.source.events).toEqual([]);
    expect(h.workspaceReads()).toBe(0);
    expect(h.reviews).toEqual([]);
  });

  it('prepares each admitted internal head once from unchanged saved inputs and never replaces its pinned scope', async () => {
    const h = await createPrWorkflow();
    const saved = JSON.stringify(h.inputs);
    expect(await h.coordinator.run(await h.admitted('head-a', 'internal'))).toMatchObject({ state: 'succeeded' });
    const next = { ...TESTKIT_OBSERVED_REVISION, headSha: 'e'.repeat(40), nativeRevision: 'head-b' };
    h.source.setRevision(next);
    h.source.setPullRequestNumber(18);
    const second = h.newRun();
    expect(await second.coordinator.run(await h.admitted('head-b', 'internal', next.headSha, 18, 'synchronize'))).toMatchObject({ state: 'succeeded' });
    expect(h.source.prepareInputs).toHaveLength(2);
    expect(h.reviews).toEqual([
      expect.objectContaining({ instructions: 'Quick composition', scmPullRequestReviewScope: expect.objectContaining({ observed: expect.objectContaining({
        baseSha: TESTKIT_OBSERVED_REVISION.baseSha, headSha: TESTKIT_OBSERVED_REVISION.headSha, nativeRevision: TESTKIT_OBSERVED_REVISION.nativeRevision,
      }) }) }),
      expect.objectContaining({ instructions: 'Quick composition', scmPullRequestReviewScope: expect.objectContaining({ observed: expect.objectContaining({
        baseSha: next.baseSha, headSha: next.headSha, nativeRevision: next.nativeRevision,
      }) }) }),
    ]);
    expect(JSON.stringify(h.inputs)).toBe(saved);
    const stale = h.newRun();
    expect(await stale.coordinator.run(await h.admitted('stale-head-a', 'internal', TESTKIT_OBSERVED_REVISION.headSha, 18))).toMatchObject({ state: 'succeeded' });
    expect(h.source.prepareInputs).toHaveLength(2);
    expect(h.reviews).toHaveLength(2);
    expect(stale.store.list().find(row => row.runId === 'stale-head-a' && row.blockId === 'quick-prepare'))
      .toMatchObject({ result: { status: 'refused', reason: 'revisionMismatch' } });
  });
});
