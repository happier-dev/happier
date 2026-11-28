import { describe, expect, it } from 'vitest';
import { isPluginError } from '@happier-dev/plugin-sdk';
import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { resolveWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionResolverV1';
import { validateWorkflowDefinition } from '@happier-dev/protocol/workflows/workflowValidationV1';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { compileActionInputJsonSchema } from '@happier-dev/protocol/actions/actionInputJsonSchemaValidation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1, setActionApprovalOverride, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { AutomationRunCauseSchema } from '@happier-dev/protocol/automations/automationRunCause';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { createPluginActionInvocation, pluginActionDeclarationRequiresConfirmationForInput } from '@happier-dev/protocol/plugins/actions/invocation';
import { freezeWorkflowActionContractV1, projectActionDefinitionForExternalDiscovery } from '@happier-dev/protocol/actions/actionCatalog';
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
import { createCommittedContributedActionSchemaReader, projectDaemonContributedActionDefinition } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import { createTargetActionExecutor, type TargetActionCurrentIntentRequest, type TargetActionCurrentIntentResult } from '@/plugins/runtime/invocation/actionExecutor';
import { createUnavailablePluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/triage/src/manifest';
import { TRIAGE_PREPARE_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/triage/src/actions/entrySessionProtocol';
import { createTriagePullRequestReviewActionTestkit, TESTKIT_OBSERVED_REVISION } from '../../../../../packages/plugins/triage/src/sessions/testkit/entrySessionTestkit.test-support';
import { parseGithubResourceUrl } from '../../../../../packages/plugins/scm-github/src/triage/locator';
import { normalizeGithubRepositoryEventForAutomation } from '../../../../../packages/plugins/scm-github/src/observations/githubRepositoryEventNormalization';
import { capturedRepositoryPullRequestEvent } from '../../../../../packages/plugins/scm-github/src/observations/testkit/githubRepositoryPullRequestEvent.fixture';
import { GITHUB_AUTOMATION_EVENT_LOCAL_IDS } from '../../../../../packages/plugins/scm-github/src/githubAutomationEvents';
import { createWorkflowCoordinator, WORKFLOW_CANCEL_REQUESTED_ABORT_REASON } from './coordinator';
import { createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { buildWorkflowActionContext } from './workflowActionContext';
import { createProductionWorkflowRunCoordinator } from './production';
import { createWorkflowRunStorageTestkit } from './workflowRunStorage.testkit';
import { observeWorkflowInvocationRecoveryEvidence } from './invocationRecoveryObserver';
import preManualPrEvent from './pullRequestReviewEvent.preManual.fixture.json';

const event = { pluginId: 'example.forge', localId: 'pull-request' };
const workspace = { machineId: 'machine-a', directory: '/repo', checkoutRootPath: '/repo' };

async function createPrWorkflow(options?: Readonly<{ baseRules?: Record<string, unknown>; standardReview?: Record<string, unknown>;
  withoutSelectedWorkspace?: boolean; manual?: boolean; missingRepository?: boolean; repositoryConnected?: () => boolean;
  observationFailure?: NonNullable<Parameters<typeof createTriagePullRequestReviewActionTestkit>[0]>['observationFailure'];
  prepareApproval?: Readonly<{
    request: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
    observe: () => Promise<ActionExecuteResult>;
  }>;
}>) {
  const reviews: unknown[] = [];
  const preparations: unknown[] = [];
  const source = await createTriagePullRequestReviewActionTestkit({
    baseRules: options?.baseRules,
    ...(options?.manual ? { manualCheckout: {
      ...(options.missingRepository ? {} : { repository: 'example/repository' }), prState: 'closed',
    } } : {}),
    repositoryConnected: options?.repositoryConnected,
    observationFailure: options?.observationFailure,
    resolveManualResourceNumber: resource => {
      const route = parseGithubResourceUrl(resource);
      return route?.kindId === 'pull-request' && route.owner === 'example' && route.name === 'repository' ? route.number : undefined;
    },
    executeReview: async raw => {
      reviews.push(raw);
      const input = ReviewStartInputSchema.parse(raw);
      return { intent: 'review', sessionId: input.sessionId,
        results: reviewReviewerIdsForStartV1(input).map(key => ({ key, ok: true, result: { runId: `run-${key}` } })) };
    },
  });
  const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
  const definitions = manifest.contributes.actions.map(action => options?.manual
    ? projectDaemonContributedActionDefinition(manifest, action) : ActionDefinitionV1Schema.parse({
    kindVersion: 1, id: `${PLUGIN_MANIFEST.id}/actions/${action.id}`, title: resolvePluginLocalizedStringV2Text(action.title),
    description: null, safety: action.dangerLevel === 'safe' ? 'safe' : 'danger', placements: [], slash: null, bindings: null, examples: null,
    surfaces: { agent: true }, inputHints: null, inputSchema: action.inputSchema, outputSchema: action.resultSchema,
  }));
  const list = () => definitions;
  const prepareDeclaration = manifest.contributes.actions.find(action => action.id === 'entries/prepare-pull-request-review-v1')!;
  const prepareActionId = `${PLUGIN_MANIFEST.id}/actions/${prepareDeclaration.id}`;
  const prepareInvocation = createPluginActionInvocation({ pluginId: manifest.id, localId: prepareDeclaration.id,
    declaration: prepareDeclaration, inputSchema: prepareDeclaration.inputSchema,
    occurrenceSignal: new AbortController().signal, isCurrent: () => true });
  const createPrepareTarget = (input: ReturnType<typeof projectNativeJsonValueForTransport>,
    requestCurrentIntent: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>,
    policy: ActionsSettingsV1 = normalizeActionsSettingsV1(undefined)) =>
    createTargetActionExecutor({
      resolve: () => ({
        qualifiedId: prepareActionId,
        pluginId: PLUGIN_MANIFEST.id, localId: prepareDeclaration.id, occurrenceId: 'triage-1',
        sourceCustody: { kind: 'development', registeredRootId: 'triage' },
        dangerLevel: prepareDeclaration.dangerLevel, scopes: prepareDeclaration.scopes, surfaces: prepareDeclaration.surfaces,
        confirmation: prepareDeclaration.confirmation, confirmationWhen: prepareDeclaration.confirmationWhen,
        approvalRequiredByActionSettings: isApprovalRequiredByActionsSettings(prepareActionId, policy, { surface: 'agent' },
          'danger', pluginActionDeclarationRequiresConfirmationForInput(prepareDeclaration, 'agent', input, 'account_automation')),
        hostAccess: [], input, policyFingerprint: 'b'.repeat(64),
      }),
      resolveAuthorizationFacts: () => ({
        generation: { targetGeneration: 'triage-1', appliedGeneration: 'triage-1', desiredGeneration: 'triage-1' },
        resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
      }),
      resolveHostBinding: async action => ({
        action, serviceBinding: createUnavailablePluginInvocationServiceBinding(action.occurrenceId, 'triage-test-binding'),
      }),
      requestCurrentIntent,
      invoke: async admitted => ({ status: 'executed', value: await source.invoke(admitted.localId,
        projectNativeJsonValueForTransport(admitted.input)) }),
    });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    listContributedActionDefinitions: list, readContributedActionSchemas: createCommittedContributedActionSchemaReader(list),
    invokeContributedAction: async request => {
      const input = projectNativeJsonValueForTransport(request.input);
      if (request.action.localId === prepareDeclaration.id) {
        const admitted = prepareInvocation.prepare(input);
        if (admitted.kind === 'settled') {
          return projectContributedActionFailure({ errorCode: admitted.result.code, error: admitted.result.message,
            actionHandlerInvocation: 'notStarted' });
        }
        preparations.push(input);
        if (options?.prepareApproval) {
          const execution = await createPrepareTarget(input, options.prepareApproval.request).execute({
            pluginId: PLUGIN_MANIFEST.id, localId: prepareDeclaration.id, input, surface: 'agent', invocationAuthority: 'account_automation',
          });
          if (execution.status !== 'deferred') throw new Error(`Expected deferred Prepare, received ${execution.status}`);
          return { ok: true, result: { kind: 'approval_request_created', artifactId: execution.artifactId,
            actionId: `${PLUGIN_MANIFEST.id}/actions/${prepareDeclaration.id}` } };
        }
      }
      try {
        return { ok: true, result: await source.invoke(request.action.localId, input) };
      } catch (error) {
        if (!isPluginError(error)) throw error;
        return projectContributedActionFailure({
          errorCode: error.code, error: error.message, data: projectNativeJsonValueForTransport(error.data),
        });
      }
    } });
  const action = { executor, buildContext: async (params: Parameters<typeof buildWorkflowActionContext>[0]) => buildWorkflowActionContext(params),
    ...(options?.prepareApproval ? { observeApproval: options.prepareApproval.observe } : {}),
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
  const address = { serverId: 'server-a', sessionId: source.savedInput.sessionId };
  const materialize = async (runId: string, admission: WorkflowMaterializationAdmissionV1, workflow = definition,
    runInputs = inputs, originSessionId?: string, scheduled = false) => {
    const automationId = 'scheduled-pr-review';
    const scheduledFor = 1_714_000_000_000;
    const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerId: 'schedule-1', triggerKind: 'schedule',
      triggerRevision: 1, occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: 'schedule-1',
        evidence: { v: 1, kind: 'schedule', scheduledFor } }), occurredAt: scheduledFor, evidence: { scheduledFor } });
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: workflow,
      context: { source: scheduled ? { kind: 'automation', automationId } : { kind: 'inline' },
        inputs: runInputs, machineId: workspace.machineId, executionTarget: { kind: 'session' }, workspaceTarget: { project: workspace },
        origin: { kind: 'direct', ...(originSessionId ? { originSessionId } : {}) },
        ...(scheduled ? { actionCaller: { kind: 'automationRun', runId, automationId, cause } } : {}),
        authorization: { principal: { kind: 'host' } } },
      admission,
      effects: { resolveTargetAvailability: async () => true,
        resolveSessionTarget: async () => ({ address, machineId: workspace.machineId }),
        admitSessionAuthority: async () => true,
        readActionContract: async id => {
          const action = definitions.find(item => item.id === id);
          return action ? freezeWorkflowActionContractV1(action) : null;
        } } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    return { ...accepted.snapshot, runId };
  };
  const admitted = async (runId: string, authorAssociation: string, headSha = TESTKIT_OBSERVED_REVISION.headSha, number = 17,
    action: typeof SCM_HOSTING_PULL_REQUEST_LIFECYCLE_ACTIONS_V1[number] = 'opened', catalog = false) => {
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
    const catalogSource = catalog ? await resolveWorkflowDefinitionRefV1('builtin:review-pull-request', { event }) : null;
    if (catalog && !catalogSource) throw new Error('Missing built-in for the admitted Event');
    return materialize(runId, { kind: 'trigger', workDepth: 0, admitLeaf: async () => { throw new Error('No native leaf admission'); },
      eventOccurrence: { event, payload: { pullRequest: projectNativeJsonValueForTransport(normalized.payload.pullRequest), reviewTarget: {
        ...reviewTarget, entryRef: { ...reviewTarget.entryRef, entryId: String(number) },
        comparisonSource: { ...reviewTarget.comparisonSource, locator: { ...reviewTarget.comparisonSource.locator, number, headOid: headSha } },
      } } } }, catalogSource?.definition ?? definition);
  };
  const manualPreparation = (runId: string) => {
    const [lifecycle] = definition.blocks;
    const author = lifecycle?.kind === 'if' ? lifecycle.then[0] : undefined;
    const prepare = author?.kind === 'if' ? author.then[0] : undefined;
    if (prepare?.kind !== 'action') throw new Error('Missing PR preparation Action');
    return materialize(runId, { kind: 'user' }, { ...definition, blocks: [prepare] });
  };
  return { source, reviews, preparations, action, ...newRun(), newRun, admitted, inputs, manualPreparation, createPrepareTarget,
    manual: (runId: string, pullRequest: string, inSession: boolean, scheduled = false) =>
      materialize(runId, scheduled ? { kind: 'trigger', workDepth: 0, admitLeaf: async () => { throw new Error('No Agent step'); } }
        : { kind: 'user' }, resolveBuiltinWorkflowDefinitionV1('review-pull-request')!.definition,
        { pullRequest, quickReview: inputs.quickReview, ...(inSession ? {} : { session: address }) },
        inSession ? address.sessionId : undefined, scheduled),
    workspaceReads: () => workspaceReads };
}

function createDurablePrWorkflow(
  { runId, ...acceptedSnapshot }: Awaited<ReturnType<Awaited<ReturnType<typeof createPrWorkflow>>['manual']>>,
  action: Awaited<ReturnType<typeof createPrWorkflow>>['action'],
) {
  const accountId = 'account-1';
  const accountCurrentness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
  const resolveEncryption = async () => ({ kind: 'available' as const, witness: accountCurrentness });
  const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
    mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot,
  }));
  const storage = createWorkflowRunStorageTestkit({ runId, accountId, machineId: workspace.machineId,
    origin: { kind: 'direct' }, acceptedEnvelope, state: 'claimed' });
  const coordinate = createProductionWorkflowRunCoordinator({ token: 'token', accountId, machineId: workspace.machineId, storage,
    workspaceScm: { inspectLocation: async () => null, verifyRecordedWorkspace: async () => 'available' },
    resolveAccountEncryption: resolveEncryption, isAcceptedAuthorizationCurrent: async () => true,
    resolveControllerContext: async () => ({ surface: 'cli', authority: 'account_automation' }),
    onCommittedTransition: async () => {}, onReviewEntered: async () => {},
    execution: { credentials: { token: 'token', encryption: null }, serverId: 'server',
      machineAdmissionTransport: async () => { throw new Error('PR preparation and review are contributed Actions'); },
      resolveExistingSessionConversation: async () => null,
      action,
      detachedRun: { actionExecutor: action.executor,
        buildActionContext: () => ({ surface: 'cli', authority: 'account_automation' }) },
    },
  });
  const reader = createWorkflowAccountRunActionOwner({ resolveAccountId: async () => accountId, resolveEncryption, storage,
    observeRecovery: ({ progress }) => observeWorkflowInvocationRecoveryEvidence({
      runId, credentials: { token: 'token', encryption: null }, machineId: workspace.machineId, progress,
      getRun: async () => { throw new Error('Prepare does not start an execution Run'); },
    }),
    normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('Plain Account requires no keys'); },
    definitions: { get: async () => { throw new Error('The accepted snapshot owns the Run definition'); } },
  });
  return { runId, storage, reader, claim: async (attempt: number) => {
    if (storage.run().state === 'queued') {
      // The storage fixture stands in for Home's new claim after an accepted Retry.
      await storage.execute({ operation: 'transition', runId, parentAttempt: attempt, state: 'claimed',
        expectedRevision: storage.run().revision, checkpointEnvelope: storage.checkpointEnvelope()! });
    }
    return await coordinate({ runId, attempt, expectedRevision: storage.run().revision, acceptedEnvelope, accountCurrentness });
  } };

}

function createPrepareApprovalTransport() {
  let publish!: (request: TargetActionCurrentIntentRequest) => void;
  let waiting!: () => void;
  let settle!: (result: ActionExecuteResult) => void;
  const requested = new Promise<TargetActionCurrentIntentRequest>(resolve => { publish = resolve; });
  const observed = new Promise<void>(resolve => { waiting = resolve; });
  const settlement = new Promise<ActionExecuteResult>(resolve => { settle = resolve; });
  return { requested, observed, settle, observe: () => {
    waiting();
    return settlement;
  }, request: async (facts: TargetActionCurrentIntentRequest) => {
    publish(facts);
    return { status: 'deferred' as const, artifactId: 'pr-prepare-approval' };
  } };
}

describe('PR review automation through the workflow coordinator', () => {
  it('holds direct Agent preparation on the exact repository, Session and head, then consumes approval once', async () => {
    const h = await createPrWorkflow({ manual: true });
    const input = await h.source.resolveManualInput();
    const prepare = (operand: typeof input, present: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>) =>
      h.createPrepareTarget(operand, present).prepare({ pluginId: PLUGIN_MANIFEST.id, localId: 'entries/prepare-pull-request-review-v1',
        input: operand, surface: 'agent', invocationAuthority: 'account_automation', sessionId: operand.sessionId });

    let approvedFingerprint = '';
    const hold = await prepare(input, async ({ action, fingerprint }) => {
      expect(action.input).toMatchObject({
        sessionId: 'session-a', instance: { instance: { sourceInstanceId: input.instance.instance.sourceInstanceId } },
        comparisonSource: { locator: { repository: 'example/repository', headOid: TESTKIT_OBSERVED_REVISION.headSha, number: 17 } },
      });
      approvedFingerprint = fingerprint;
      return { status: 'deferred', artifactId: 'manual-pr-approval' };
    });
    expect(hold).toMatchObject({ kind: 'settled', result: { status: 'deferred', artifactId: 'manual-pr-approval' } });
    expect(h.source.prepareInputs).toEqual([]);

    const approve = async () => ({ status: 'approved' as const, fingerprint: approvedFingerprint });
    if (input.comparisonSource.kind !== 'pullRequest') throw new Error('Expected a PR comparison');
    for (const altered of [
      { ...input, sessionId: 'session-b' },
      { ...input, comparisonSource: { ...input.comparisonSource,
        locator: { ...input.comparisonSource.locator, repository: 'example/other' } } },
    ]) {
      expect(await prepare(altered, approve)).toMatchObject({
        kind: 'settled', result: { status: 'unavailable', code: 'plugin_action_current_intent_mismatch' },
      });
    }
    expect(h.source.prepareInputs).toEqual([]);
    const admitted = await prepare(input, approve);
    if (admitted.kind !== 'ready') throw new Error('Expected an approved Prepare');
    for (const result of await Promise.all([admitted.run(), admitted.run()])) {
      expect(result).toMatchObject({ status: 'executed', value: { status: 'prepared' } });
    }
    expect(h.source.prepareInputs).toHaveLength(1);
  });

  it('rejects a raw link at the Prepare Action admission boundary', async () => {
    const h = await createPrWorkflow({ manual: true });
    await expect(h.action.executor.execute('action.invoke', {
      action: { pluginId: PLUGIN_MANIFEST.id, localId: 'entries/prepare-pull-request-review-v1' },
      input: { v: 1, sessionId: 'session-a', pullRequest: 'https://github.com/example/repository/pull/17' },
    }, { surface: 'agent' })).resolves.toMatchObject({ ok: false, errorCode: 'plugin_action_input_schema_invalid', effectAttempted: false });
    expect(h.preparations).toEqual([]);
    expect(h.source.prepareInputs).toEqual([]);
  });

  it('refuses a direct Agent Prepare using a resolved operand after its PRs & Issues source was removed', async () => {
    const h = await createPrWorkflow({ manual: true });
    const input = await h.source.resolveManualInput();
    expect(await h.source.removeReviewSource()).toMatchObject({ kind: 'removed' });
    const localId = 'entries/prepare-pull-request-review-v1';
    const policy = setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined),
      actionId: `${PLUGIN_MANIFEST.id}/actions/${localId}`, surface: 'agent', approvalRequired: false });
    const execute = h.createPrepareTarget(input, async () => {
      throw new Error('The saved Direct waiver must skip approval');
    }, policy);
    await expect(execute.execute({ pluginId: PLUGIN_MANIFEST.id, localId, input, surface: 'agent',
      invocationAuthority: 'account_automation' })).resolves.toMatchObject({
      status: 'failed', code: 'sourceUnavailable', message: expect.stringContaining('Connect the repository in PRs & Issues'),
    });
    expect(h.source.prepareInputs).toEqual([]);
  });

  it('refuses inside the approved Agent Prepare body when the repository is no longer selected', async () => {
    let selected = true;
    const h = await createPrWorkflow({ manual: true, repositoryConnected: () => selected });
    const input = await h.source.resolveManualInput();
    const localId = TRIAGE_PREPARE_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1;
    const request = { pluginId: PLUGIN_MANIFEST.id, localId, input, surface: 'agent' as const,
      invocationAuthority: 'account_automation' as const };
    let approvedFingerprint = '';
    const pending = h.createPrepareTarget(input, async ({ fingerprint }) => {
      approvedFingerprint = fingerprint;
      return { status: 'deferred', artifactId: 'manual-pr-approval' };
    });
    expect(await pending.execute(request)).toMatchObject({
      status: 'deferred', artifactId: 'manual-pr-approval',
    });
    expect(h.source.executionOptions).toEqual([]);

    selected = false;
    const replay = h.createPrepareTarget(input, async () => ({ status: 'approved', fingerprint: approvedFingerprint }));
    const admitted = await replay.prepare(request);
    if (admitted.kind !== 'ready') throw new Error('Expected the exact approved Prepare body');
    for (const result of await Promise.all([admitted.run(), admitted.run()])) {
      expect(result).toMatchObject({ status: 'failed', code: 'sourceUnavailable',
        message: expect.stringContaining('Connect the repository in PRs & Issues') });
    }
    expect(h.source.executionOptions).toEqual([]);
    expect(h.source.prepareInputs).toEqual([]);
  });

  it('honors a saved Direct waiver while still preparing only the resolved head', async () => {
    const h = await createPrWorkflow({ manual: true });
    const localId = 'entries/prepare-pull-request-review-v1';
    const policy = setActionApprovalOverride({ settings: normalizeActionsSettingsV1(undefined),
      actionId: `${PLUGIN_MANIFEST.id}/actions/${localId}`, surface: 'agent', approvalRequired: false });
    const input = await h.source.resolveManualInput();
    const execute = () => h.createPrepareTarget(input, async () => {
      throw new Error('The saved Direct waiver must skip approval');
    }, policy).execute({ pluginId: PLUGIN_MANIFEST.id, localId, input, surface: 'agent', invocationAuthority: 'account_automation' });

    h.source.setRevision({ ...TESTKIT_OBSERVED_REVISION, headSha: 'e'.repeat(40) });
    await expect(execute()).resolves.toMatchObject({ status: 'failed', code: 'observedHeadMoved',
      message: expect.stringContaining('Start the Workflow again') });
    expect(h.source.prepareInputs).toEqual([]);

    h.source.setRevision(TESTKIT_OBSERVED_REVISION);
    await expect(execute()).resolves.toMatchObject({ status: 'executed', value: { status: 'prepared' } });
    expect(h.source.prepareInputs).toEqual([expect.objectContaining({ observed: expect.objectContaining({ headSha: TESTKIT_OBSERVED_REVISION.headSha }) })]);
  });

  it('holds scheduled manual reviews at the same approval with no source preparation', async () => {
    const approval = createPrepareApprovalTransport();
    const h = await createPrWorkflow({ manual: true, prepareApproval: approval });
    const run = await h.manual('scheduled-manual-pr', '17', false, true);
    const running = h.coordinator.run(run);
    try {
      const held = await Promise.race([approval.requested, running]);
      expect(held).toMatchObject({ action: { input: {
        sessionId: 'session-a', comparisonSource: { locator: { repository: 'example/repository' } },
      } } });
      await Promise.race([approval.observed, running]);
      expect(h.store.list()).toContainEqual(expect.objectContaining({
        blockId: 'quick-prepare', lifecycle: 'waiting_for_approval', reason: 'approval_required',
      }));
      expect(h.source.prepareInputs).toEqual([]);
      expect(h.reviews).toEqual([]);
    } finally {
      approval.settle({ ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' });
      await running;
    }
    expect(h.store.list()).toContainEqual(expect.objectContaining({
      blockId: 'quick-prepare', execution: expect.objectContaining({
        output: expect.objectContaining({ artifactId: 'pr-prepare-approval' }),
      }),
    }));
  });

  it('holds Prepare under Ask, rejects a moved head and dispatches the approved operand once on a fresh Run', async () => {
    const next = { ...TESTKIT_OBSERVED_REVISION, headSha: 'e'.repeat(40) };
    let approval = createPrepareApprovalTransport();
    const h = await createPrWorkflow({ manual: true, prepareApproval: {
      request: request => approval.request(request), observe: () => approval.observe(),
    } });
    for (const stale of [true, false]) {
      const { coordinator, store } = h.newRun();
      const accepted = await h.manual(stale ? 'old-head' : 'new-head', '17', true);
      const running = coordinator.run(accepted);
      try {
        const held = await Promise.race([approval.requested, running]);
        if (!('action' in held)) throw new Error(`Prepare did not request approval: ${JSON.stringify(held)}`);
        expect(held.action.input).toMatchObject({
          sessionId: 'session-a', entryRef: { entryId: expect.stringMatching(/17$/) },
          instance: { instance: { sourceInstanceId: expect.any(String) } },
          comparisonSource: { locator: {
            repository: 'example/repository', headOid: stale ? TESTKIT_OBSERVED_REVISION.headSha : next.headSha,
          } },
        });
        expect(held.action.input).toEqual(h.preparations.at(-1));
        await Promise.race([approval.observed, running]);
        expect(store.list()).toContainEqual(expect.objectContaining({
          blockId: 'quick-prepare', lifecycle: 'waiting_for_approval', reason: 'approval_required',
        }));
        expect(h.source.prepareInputs).toEqual([]);
        expect(h.reviews).toEqual([]);
        if (stale) h.source.setRevision(next);
        const approved = projectNativeJsonValueForTransport(held.action.input);
        const result = await h.createPrepareTarget(approved, async () => ({ status: 'approved', fingerprint: held.fingerprint }))
          .execute({ pluginId: held.action.pluginId, localId: held.action.localId, input: approved,
            surface: 'agent', invocationAuthority: 'account_automation' });
        if (result.status === 'deferred') throw new Error('Approval replay asked again');
        approval.settle(result.status === 'executed' ? { ok: true, result: result.value }
          : projectContributedActionFailure({ errorCode: result.code, error: result.message, data: result.data }));
        if (stale) {
          expect(await running).toMatchObject({ state: 'interrupted', reason: 'observedHeadMoved' });
          expect(store.list()).toContainEqual(expect.objectContaining({ blockId: 'quick-prepare',
            reason: 'observedHeadMoved', reasonMessage: expect.stringContaining('Start the Workflow again') }));
          expect(h.source.prepareInputs).toEqual([]);
          expect(h.reviews).toEqual([]);
        } else {
          expect(await running).toMatchObject({ state: 'succeeded' });
          expect(h.source.prepareInputs).toEqual([expect.objectContaining({
            entryRef: expect.objectContaining({ entryId: '17' }),
            observed: expect.objectContaining({ headSha: next.headSha }),
          })]);
          expect(h.reviews).toHaveLength(1);
        }
      } finally {
        approval.settle({ ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' });
        await running;
      }
      if (stale) approval = createPrepareApprovalTransport();
    }
  });

  it('publishes all three manual PR reads as Account Workflow Actions', () => {
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
    for (const localId of [
      'entries/resolve-resource-v1', 'entries/read-detail-v1', 'entries/reobserve-v1',
    ]) {
      const declaration = manifest.contributes.actions.find(action => action.id === localId);
      if (!declaration) throw new Error(`Missing Triage Action ${localId}`);
      const definition = projectDaemonContributedActionDefinition(manifest, declaration);
      expect(projectActionDefinitionForExternalDiscovery(definition), localId).toMatchObject({
        executionPlacement: 'account', automation: { workflowStep: true },
      });
    }
  });

  it.each([
    { inSession: false, reference: 'https://github.com/example/repository/pull/17/files' },
    { inSession: true, reference: 'https://github.com/example/repository/pull/17' },
    { inSession: true, reference: '17' },
    { inSession: true, reference: '#17' },
  ])('reviews $reference through the provider locator (Agent Session default: $inSession)', async ({ inSession, reference }) => {
    const h = await createPrWorkflow({ manual: true });
    const accepted = await h.manual('manual-pr-review', reference, inSession);
    expect(accepted.materializedLeaves.map(leaf => leaf.blockId)).toEqual(['resolve-pr', 'read-pr-source', 'observe-pr', 'quick-prepare', 'quick-review']);
    expect(await h.coordinator.run(accepted)).toMatchObject({ state: 'succeeded' });
    expect(h.source.prepareInputs).toHaveLength(1);
    expect(h.reviews).toEqual([expect.objectContaining({ sessionId: h.source.savedInput.sessionId })]);
  });

  it('resolves repository-qualified PR shorthand through the connected GitHub source', async () => {
    const h = await createPrWorkflow({ manual: true });
    const accepted = await h.manual('manual-pr-qualified', 'example/repository#17', true);
    expect(await h.coordinator.run(accepted)).toMatchObject({ state: 'succeeded' });
    expect(h.source.prepareInputs).toEqual([expect.objectContaining({
      entryRef: expect.objectContaining({ entryId: '17' }),
      observed: expect.objectContaining({ headSha: TESTKIT_OBSERVED_REVISION.headSha }),
    })]);
  });

  it('asks for the repository when Run now receives a number without a repository context', async () => {
    const h = await createPrWorkflow({ manual: true, missingRepository: true });
    const accepted = await h.manual('manual-pr-needs-repository', '#17', false);
    expect(await h.coordinator.run(accepted)).toMatchObject({ state: 'interrupted', reason: 'invalid_input' });
    expect(h.store.list()).toContainEqual(expect.objectContaining({ blockId: 'resolve-pr', reason: 'invalid_input',
      reasonMessage: expect.stringContaining('repository'),
      result: expect.objectContaining({ details: { field: 'repository', reason: 'repository_needed' } }),
    }));
    expect(h.source.prepareInputs).toEqual([]);
  });

  it('reports the provider’s typed not-found for an unknown PR number in a Session', async () => {
    const h = await createPrWorkflow({ manual: true });
    const accepted = await h.manual('manual-pr-not-found', '#99', true);
    expect(await h.coordinator.run(accepted)).toMatchObject({ state: 'interrupted', reason: 'github_not_found' });
    expect(h.store.list()).toContainEqual(expect.objectContaining({ blockId: 'observe-pr', reason: 'github_not_found' }));
    expect(h.source.prepareInputs).toEqual([]);
  });

  it('keeps Triage’s remedy readable to the Agent and retries after the repository is connected', async () => {
    let connected = false;
    const h = await createPrWorkflow({ manual: true, repositoryConnected: () => connected });
    const accepted = await h.manual('11111111-1111-4111-8111-111111111112', 'https://github.com/example/repository/pull/17', true);
    const { runId, storage, reader, claim } = createDurablePrWorkflow(accepted, h.action);
    expect(await claim(0)).toMatchObject({ state: 'interrupted', reason: 'sourceUnavailable' });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, callerPermissionMode: 'yolo' as const };
    const page = WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true }, context,
    }));
    const resolution = page.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'resolve-pr');
    if (!resolution) throw new Error('Missing PR resolution invocation');
    const detail = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.get', input: { runId, invocationId: resolution.index.id }, context,
    })).invocation;
    expect(detail.index.lifecycle).toBe('failed');
    expect(detail.progress.result).toMatchObject({ name: 'PluginError', code: 'sourceUnavailable', effectAttempted: false });
    expect(detail.progress.reason).toMatchObject({
      code: 'sourceUnavailable', message: 'Connect the repository in PRs & Issues, then try the pull request again.',
    });
    expect(h.source.prepareInputs).toEqual([]);
    expect(h.reviews).toEqual([]);

    connected = true;
    const retry = detail.recoveryAvailability?.retry;
    if (retry?.kind !== 'available') throw new Error(`Resolve Retry unavailable: ${retry?.reason ?? 'missing'}`);
    const recovered = WorkflowActionOutputSchemasV1['workflow.run.invocations.retry'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.retry',
      input: { runId, expectedRevision: storage.run().revision, invocation: { recordId: detail.index.id },
        causalInvocationIds: retry.causalInvocationIds, conversation: 'fresh_agent', input: { kind: 'original' } },
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' },
    }));
    expect(recovered.disposition).toBe('accepted');
    expect(await claim(1)).toMatchObject({ state: 'succeeded' });
    expect(h.source.prepareInputs).toHaveLength(1);
    expect(h.reviews).toHaveLength(1);
  });

  it('tells the Run and Agent to reconnect when the source credential is lost during reobserve', async () => {
    const remedy = 'Reconnect the source account in PRs & Issues, then try the pull request again.';
    const h = await createPrWorkflow({ manual: true, observationFailure: {
      class: 'authentication', code: 'connected_service_credential_reconnect_required',
    } });
    const accepted = await h.manual('11111111-1111-4111-8111-111111111113', '17', true);
    const { runId, reader, claim } = createDurablePrWorkflow(accepted, h.action);
    expect(await claim(0)).toMatchObject({ state: 'interrupted', reason: 'connected_service_credential_reconnect_required' });
    const reason = { code: 'connected_service_credential_reconnect_required', message: remedy };
    const page = WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.list', input: { runId, includeContent: true },
      context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'yolo' },
    }));
    const observation = page.invocationDetails?.find(row => row.progress.invocationPath.blockId === 'observe-pr');
    expect(observation?.index.lifecycle).toBe('failed');
    expect(observation?.progress.reason).toMatchObject(reason);
    const detail = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].parse(await reader.execute({
      actionId: 'workflow.run.invocations.get', input: { runId, invocationId: observation!.index.id },
      context: { surface: 'agent', authority: 'account_automation', callerPermissionMode: 'yolo' },
    }));
    expect(detail.invocation.progress.reason).toMatchObject(reason);
    expect(h.source.prepareInputs).toEqual([]);
    expect(h.reviews).toEqual([]);
  });

  // Event vectors were captured at 8eb12640b713. Per FIN's second-review M2 ruling,
  // fresh Runs freeze the wider Prepare contract, and the pre-manual Event operand still works.
  it.each(preManualPrEvent.cases)('preserves the recipe, operands and behavior for a $association Event', async expected => {
    const h = await createPrWorkflow();
    const catalog = await h.admitted('event-pr', expected.association, TESTKIT_OBSERVED_REVISION.headSha, 17, 'opened', true);
    expect(catalog.authoredDefinition).toEqual(preManualPrEvent.recipe);
    expect(catalog.triggerEventValues).toEqual(expected.eventOperands);
    const declarations = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST).contributes.actions;
    const prepareId = `${PLUGIN_MANIFEST.id}/actions/${TRIAGE_PREPARE_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1}`;
    expect(catalog.materializedLeaves).toMatchObject(preManualPrEvent.leaves.map(leaf => {
      if (!leaf.actionId) return leaf;
      const declaration = declarations.find(action => `${PLUGIN_MANIFEST.id}/actions/${action.id}` === leaf.actionId);
      if (!declaration) throw new Error(`Missing Event Action declaration for ${leaf.blockId}`);
      return { ...leaf, actionContract: {
        inputSchema: declaration.inputSchema,
        outputSchema: declaration.resultSchema,
        secretInputPaths: [],
      } };
    }));
    const preparations = catalog.materializedLeaves.filter(leaf => leaf.actionId === prepareId);
    expect(preparations.map(leaf => leaf.blockId)).toEqual(['quick-prepare', 'standard-prepare']);
    for (const leaf of preparations) {
      const schema = leaf.actionContract?.inputSchema;
      expect(schema).toMatchObject({ anyOf: [
        expect.objectContaining({ properties: expect.objectContaining({ request: expect.any(Object) }) }),
        expect.objectContaining({ properties: expect.objectContaining({ kind: { const: 'resolvedPullRequestForSession' } }) }),
      ] });
      if (!schema || typeof schema !== 'object') throw new Error('Missing frozen Prepare input schema');
      expect(compileActionInputJsonSchema(schema)(preManualPrEvent.prepareOperand)).toBe(true);
    }
    const outcome = await h.coordinator.run(catalog);
    expect(h.preparations).toEqual(expected.association === 'internal' ? [preManualPrEvent.prepareOperand] : []);
    expect({
      state: outcome.state, sourceEvents: h.source.events,
      reviews: h.reviews.map(raw => {
        const review = ReviewStartInputSchema.parse(raw);
        return { sessionId: review.sessionId, reviewers: reviewReviewerIdsForStartV1(review), instructions: review.instructions };
      }),
      hold: h.store.list().find(row => row.blockId === 'approve-pr-setup')?.input?.input,
    }).toEqual(expected.behavior);
  });

  it('settles invalid preparation input with the typed issues readable from the exact Run', async () => {
    const h = await createPrWorkflow();
    const accepted = await h.manualPreparation('11111111-1111-4111-8111-111111111111');
    const { runId, storage, reader, claim } = createDurablePrWorkflow(accepted, h.action);
    expect(await claim(0)).toMatchObject({ state: 'failed', reason: 'invalid_input' });
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
