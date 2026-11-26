import { describe, expect, it } from 'vitest';
import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { materializeWorkflowAcceptedSnapshotV1, type WorkflowMaterializationAdmissionV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { createPullRequestReviewWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/pullRequestReview';
import { reviewReviewerIdsForStartV1, ReviewStartInputSchema } from '@happier-dev/protocol/reviews/reviewStart';
import { SCM_HOSTING_PULL_REQUEST_LIFECYCLE_ACTIONS_V1 } from '@happier-dev/protocol/scm/pullRequestLifecycleActionsV1';
import { createWorkflowAccountRunActionOwner, sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';
import { createTriagePullRequestReviewActionTestkit, TESTKIT_OBSERVED_REVISION } from '../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support';
import { normalizeGithubRepositoryEventForAutomation } from '../../../../../packages/plugins/scm-github/src/observations/githubRepositoryEventNormalization';
import { capturedRepositoryPullRequestEvent } from '../../../../../packages/plugins/scm-github/src/observations/testkit/githubRepositoryPullRequestEvent.fixture';
import { GITHUB_AUTOMATION_EVENT_LOCAL_IDS } from '../../../../../packages/plugins/scm-github/src/githubAutomationEvents';
import { createWorkflowCoordinator, WORKFLOW_CANCEL_REQUESTED_ABORT_REASON } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { buildWorkflowActionContext } from './workflowActionContext';
import { createProductionWorkflowRunCoordinator } from './production';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';

const event = { pluginId: 'example.forge', localId: 'pull-request' };
const workspace = { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' };

async function createPrWorkflow(options?: Readonly<{ baseRules?: Record<string, unknown>; standardReview?: Record<string, unknown>;
  withoutSelectedWorkspace?: boolean }>) {
  const reviews: unknown[] = [];
  const preparations: unknown[] = [];
  const source = await createTriagePullRequestReviewActionTestkit({ baseRules: options?.baseRules, executeReview: async raw => {
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
    invokeContributedAction: async request => {
      const input = projectNativeJsonValueForTransport(request.input);
      if (request.action.localId === 'entries/prepare-pull-request-review-v1') preparations.push(input);
      return { ok: true, result: await source.invoke(request.action.localId, input) };
    } });
  const action = { executor, buildContext: async (params: Parameters<typeof buildWorkflowActionContext>[0]) => buildWorkflowActionContext(params),
    observeRun: async () => { throw new Error('Triage returns the admitted Review'); } };
  let workspaceReads = 0;
  const newRun = () => {
    // Production binds a coordinator store and its frontier to one Workflow Run.
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createWorkflowCoordinator({ store,
      executeStep: async () => { throw new Error('Review engines belong to the Review Action'); },
      resolveWorkspace: async () => { workspaceReads++; return { ok: true, workspace }; },
      action });
    return { store, coordinator };
  };
  const definition = createPullRequestReviewWorkflowV1(event);
  const { v: _version, reviewTarget, ...savedInputs } = source.savedInput;
  const { workspace: _selectedWorkspace, ...unplacedRequest } = savedInputs.request;
  const inputs = Object.fromEntries(Object.entries({ ...savedInputs,
    ...(options?.withoutSelectedWorkspace ? { request: unplacedRequest } : {}),
    quickReview: { reviewers: [{ kind: 'engine', engineId: 'engine-a' }], instructions: 'Quick composition' },
    standardReview: options?.standardReview ?? { reviewers: [{ kind: 'engine', engineId: 'engine-a' }, { kind: 'engine', engineId: 'engine-b' }], instructions: 'Standard composition' },
  }).map(([key, value]) => [key, projectNativeJsonValueForTransport(value)]));
  const materialize = async (runId: string, admission: WorkflowMaterializationAdmissionV1, workflow = definition) => {
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: workflow,
      context: { source: { kind: 'inline' }, inputs, machineId: workspace.machineId, executionTarget: { kind: 'session' },
        workspaceTarget: { project: workspace }, origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission,
      effects: { resolveTargetAvailability: async () => true,
        readActionContract: async id => {
          const action = definitions.find(item => item.id === id);
          return action ? freezeWorkflowActionContractV1(action) : null;
        } } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    return { ...accepted.snapshot, runId };
  };
  const admitted = async (runId: string, authorAssociation: string, headSha = TESTKIT_OBSERVED_REVISION.headSha, number = 17,
    action: typeof SCM_HOSTING_PULL_REQUEST_LIFECYCLE_ACTIONS_V1[number] = 'opened') => {
    // The provider HTTP boundary supplies native facts. Keep its real classifier
    // and normalization on the path into the workflow's author-approval branch.
    const nativeAssociation = authorAssociation === 'internal' ? 'MEMBER'
      : authorAssociation === 'external' ? 'CONTRIBUTOR' : undefined;
    const providerEvent = { ...capturedRepositoryPullRequestEvent, payload: {
      ...capturedRepositoryPullRequestEvent.payload, action: action === 'merged' ? 'closed' : action,
      pull_request: { ...capturedRepositoryPullRequestEvent.payload.pull_request, number,
        user: { id: 101, login: 'first-contributor', type: 'User' },
        ...(nativeAssociation === undefined ? {} : { author_association: nativeAssociation }),
        merged: action === 'merged',
        head: { ...capturedRepositoryPullRequestEvent.payload.pull_request.head, sha: headSha } },
    } };
    const normalized = normalizeGithubRepositoryEventForAutomation(providerEvent, {
      v: 1, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets',
    }, GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle).observation;
    if (!normalized || !('pullRequest' in normalized.payload)) throw new Error('Provider emitted no PR lifecycle occurrence');
    return materialize(runId, { kind: 'trigger', workDepth: 0, admitLeaf: async () => { throw new Error('No native leaf admission'); },
      eventOccurrence: { event, payload: { pullRequest: projectNativeJsonValueForTransport(normalized.payload.pullRequest), reviewTarget: {
        ...reviewTarget, entryRef: { ...reviewTarget.entryRef, entryId: String(number) },
        comparisonSource: { ...reviewTarget.comparisonSource, locator: { ...reviewTarget.comparisonSource.locator, number, headOid: headSha } },
      } } } });
  };
  const manualPreparation = (runId: string) => {
    const [lifecycle] = definition.blocks;
    const author = lifecycle?.kind === 'if' ? lifecycle.then[0] : undefined;
    const prepare = author?.kind === 'if' ? author.then[0] : undefined;
    if (prepare?.kind !== 'action') throw new Error('Missing PR preparation Action');
    return materialize(runId, { kind: 'user' }, { ...definition, blocks: [prepare] });
  };
  return { source, reviews, preparations, action, ...newRun(), newRun, admitted, inputs, manualPreparation,
    workspaceReads: () => workspaceReads };
}

describe('PR review automation through the workflow coordinator', () => {
  it('settles invalid preparation input with the typed issues readable from the exact Run', async () => {
    const h = await createPrWorkflow();
    const { runId, ...acceptedSnapshot } = await h.manualPreparation('11111111-1111-4111-8111-111111111111');
    const accountId = 'account-1';
    const accountCurrentness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
    const resolveEncryption = async () => ({ kind: 'available' as const, witness: accountCurrentness });
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot,
    }));
    const storage = createWorkflowRunStorageTestkit({ runId, accountId, machineId: workspace.machineId,
      origin: { kind: 'direct' }, acceptedEnvelope, state: 'claimed' });
    const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: workspace.machineId, storage,
      resolveAccountEncryption: resolveEncryption, isAcceptedAuthorizationCurrent: async () => true,
      resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
      onCommittedTransition: async () => {}, onReviewEntered: async () => {},
      execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',
        machineAdmissionTransport: async () => { throw new Error('Invalid input must not dispatch'); },
        resolveExistingSessionConversation: async () => null,
        action: h.action,
        detachedRun: { actionExecutor: h.action.executor,
          buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) },
      },
    });
    expect(await coordinate({ runId, attempt: 0, expectedRevision: storage.run().revision, acceptedEnvelope, accountCurrentness }))
      .toMatchObject({ state: 'failed', reason: 'invalid_input' });
    const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId, resolveEncryption, storage,
      normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('Plain Account requires no keys'); },
      definitions: { get: async () => { throw new Error('The accepted snapshot owns the Run definition'); } },
    });
    const run = WorkflowActionOutputSchemasV1['workflow.run.get'].parse(await reader.execute({
      actionId: 'workflow.run.get', input: { runId }, context: {},
    }));
    expect(run.run).toMatchObject({ id: runId, state: 'failed' });
    expect(storage.calls).toContainEqual(expect.objectContaining({ operation: 'transition', state: 'failed', errorCode: 'invalid_input' }));
    const page = WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context: {},
    }));
    expect(page.invocationDetails?.some(row => row.progress.invocationPath.blockId === 'approve-pr-setup')).toBe(false);
    const preparation = page.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'quick-prepare');
    if (!preparation) throw new Error('Missing PR preparation invocation');
    const detail = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.get', input: { runId, invocationId: preparation.index.id }, context: {},
    }));
    expect(detail.invocation.index.lifecycle).toBe('failed');
    expect(detail.invocation.progress).toMatchObject({ reason: { code: 'invalid_input' }, validationIssues: expect.arrayContaining([
      { pointer: '/reviewTarget', message: expect.any(String) },
      { pointer: '/expectedHeadSha', message: expect.any(String) },
    ]) });
    expect(h.source.events).toEqual([]);
    expect(h.reviews).toEqual([]);
  });

  it('reads optional rules at the PR base commit and skips a nonmatching base before starting reviewers', async () => {
    const h = await createPrWorkflow({ baseRules: { baseRefs: ['release/*'] } });
    const run = await h.admitted('skip-other-base', 'internal');
    expect(await h.coordinator.run(run)).toMatchObject({ state: 'succeeded' });
    expect(h.source.rulesReads).toEqual([expect.objectContaining({ path: '.happier/review-rules.json',
      selector: { commit: TESTKIT_OBSERVED_REVISION.baseSha } })]);
    expect(h.reviews).toEqual([]);
    expect(h.store.list()).toContainEqual(expect.objectContaining({ blockId: 'quick-prepare',
      result: expect.objectContaining({ status: 'skipped', reason: 'baseRef' }) }));
  });
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
    expect(hold.input?.input).toEqual([
      'first-contributor', '101', association, 'acme/widgets', 17, TESTKIT_OBSERVED_REVISION.headSha,
      h.inputs.standardReview,
    ]);
    expect(hold.input?.renderedText).toEqual(expect.stringContaining('first-contributor'));
    expect(hold.input?.renderedText).toEqual(expect.stringContaining('engine-b'));
    await h.store.commitFact({ key: hold.key, lifecycle: 'completed' });
    const continued = await h.coordinator.run(run);
    expect(continued, JSON.stringify(h.store.list().map(({ blockId, lifecycle, reason }) => ({ blockId, lifecycle, reason })))).toMatchObject({ state: 'succeeded' });
    expect(h.source.prepareInputs).toHaveLength(1);
    expect(h.reviews).toEqual([expect.objectContaining({ instructions: 'Standard composition',
      reviewers: [{ kind: 'engine', engineId: 'engine-a' }, { kind: 'engine', engineId: 'engine-b' }] })]);
  });

  it('holds an unplaced preparation request without replacing its source-owned workspace decision', async () => {
    const h = await createPrWorkflow({ withoutSelectedWorkspace: true });
    const run = await h.admitted('unplaced-approval', 'external');
    expect(await h.coordinator.run(run)).toMatchObject({ state: 'waiting_for_review' });
    expect(h.source.events).toEqual([]);
    expect(h.workspaceReads()).toBe(0);
  });

  it('captures the complete Standard composition including its review and verification steps', async () => {
    const h = await createPrWorkflow({ standardReview: { instructions: 'Read then verify',
      reviewers: [{ kind: 'engine', engineId: 'engine-a' }], steps: [
        { kind: 'review', reviewers: [{ kind: 'engine', engineId: 'engine-a' }], instructions: 'Review the change' },
        { kind: 'verify', reviewers: [{ kind: 'engine', engineId: 'engine-b' }], instructions: 'Verify the findings' },
      ] } });
    expect(await h.coordinator.run(await h.admitted('steps-approval', 'external'))).toMatchObject({ state: 'waiting_for_review' });
    expect(h.store.list().find(row => row.blockId === 'approve-pr-setup')?.input?.input[6]).toEqual(h.inputs.standardReview);
    expect(h.source.events).toEqual([]);
    expect(h.workspaceReads()).toBe(0);
  });

  it('retains the admitted approval facts when an unanswered wait is resumed with changed caller inputs', async () => {
    const h = await createPrWorkflow();
    const run = await h.admitted('retained-approval', 'external');
    expect(await h.coordinator.run(run)).toMatchObject({ state: 'waiting_for_review' });
    const hold = h.store.list().find(row => row.blockId === 'approve-pr-setup');
    expect(hold?.input?.input).toContain('first-contributor');
    const original = hold?.input;
    expect(await h.coordinator.run({ ...run, inputs: { ...run.inputs,
      standardReview: { reviewers: [{ kind: 'engine', engineId: 'different-reviewer' }] },
    } })).toMatchObject({ state: 'waiting_for_review' });
    expect(h.store.list().find(row => row.blockId === 'approve-pr-setup')?.input).toEqual(original);
    expect(h.source.events).toEqual([]);
    expect(h.workspaceReads()).toBe(0);
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
    expect(h.preparations).toEqual([
      expect.objectContaining({ sessionId: h.inputs.sessionId }),
      expect.objectContaining({ sessionId: h.inputs.sessionId }),
    ]);
    expect(h.source.prepareInputs).toHaveLength(2);
    expect(h.reviews).toEqual([
      expect.objectContaining({ sessionId: h.inputs.sessionId, instructions: 'Quick composition', scmPullRequestReviewScope: expect.objectContaining({ observed: expect.objectContaining({
        baseSha: TESTKIT_OBSERVED_REVISION.baseSha, headSha: TESTKIT_OBSERVED_REVISION.headSha, nativeRevision: TESTKIT_OBSERVED_REVISION.nativeRevision,
      }) }) }),
      expect.objectContaining({ sessionId: h.inputs.sessionId, instructions: 'Quick composition', scmPullRequestReviewScope: expect.objectContaining({ observed: expect.objectContaining({
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
