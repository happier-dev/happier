import { isReviewedMachineSetupCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1, MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MachineSetupApplyInputV1Schema, MachineSetupCombinedPlanInputV1Schema, MachineSetupCombinedPlanResultV1Schema, MachineSetupPlanResultV1Schema, buildMachineSetupTargetApplyInput, machineSetupPlanInputFromApplyTargetV1, type MachineSetupApplyInputV1, type MachineSetupApplyTargetV1, type MachineSetupCombinedPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveCombinedActionWorkflowHostV1, prepareWorkflowRunStartV1 } from '@happier-dev/protocol/workflows/workflowStartPreparationV1';
import { deriveBackupReceiverSetupRunIdV1, deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import type { ActionExecutorContext, ActionExecutorDeps, WorkflowActionExecuteArgs } from '@happier-dev/protocol/actions/executor/types';
import { selectMachineSetupRecipeItemsV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { MachineSetupPlanResultV1, MachineSetupPlanReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachineSetupApplyResultV1Schema, type MachineSetupRetryV1 } from '@happier-dev/protocol/machines/setup/machineSetupOperationV1';
import { ActionOperationCompletionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { WorkflowCombinedRunStartV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import type { WorkflowActionLeafV1, WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { WorkflowActionOutputSchemasV1, WorkflowRunWaitSnapshotV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readHostAdmittedReviewedChildV1, readHostReviewedChildReceivingAdmissionV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { isBackupReceiverSetupChildOperandV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/reviewedChildFamilyV1';
import { isBackupReceiverSelection } from './backupReceiverResult';

type Preparation = NonNullable<ActionExecutorDeps['prepareMachineSetupApply']>;
type HostFacts = Pick<Parameters<typeof resolveCombinedActionWorkflowHostV1>[0], 'machines' | 'createdMachineIds' | 'agentMachineId'>;
type AppReview = NonNullable<MachineSetupPlanResultV1['appReviews']>[number];
type AppObservation = NonNullable<MachineSetupPlanReviewV1['apps']>[number];
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

export type CombinedMachineSetupInvocationRead =
  | Omit<WorkflowActionExecuteArgs<'workflow.run.invocations.list'>, 'context'>
  | Omit<WorkflowActionExecuteArgs<'workflow.run.invocations.get'>, 'context'>;

export function readMachineSetupWorkflowRetry(input: MachineSetupRetryV1, result: unknown): MachineSetupRetryV1 | undefined {
  const opened = WorkflowActionOutputSchemasV1['workflow.run.invocations.get'].safeParse(result);
  if (!opened.success) return undefined;
  const { index, recoveryAvailability } = opened.data.invocation;
  return index.runId === input.runId && index.id === input.invocationId
    && recoveryAvailability?.retry.kind === 'available' ? input : undefined;
}

export { buildMachineSetupTargetApplyInput } from '@happier-dev/protocol/machines/managed/actionsV1';

/** Authored apps and their reviewed children both require the Setup app flow. */
export function machineSetupTargetHasApps(target: MachineSetupApplyTargetV1): boolean {
  return Boolean(target.appChildren?.length)
    || target.sources.some(source => source.kind !== 'accountPresetOpaque'
      && source.setup.items?.some(item => item.kind === 'app' || item.kind === 'agent'));
}

/** The accepted Setup's installed Run and the signed receiving leaf carry the same origin. */
export function readMachineSetupAcceptedRunId(context: ActionExecutorContext): string | undefined {
  const caller = context.actionCaller;
  if (caller?.kind === 'workflowRun' && context.executionRunWorkflowRunId === caller.runId) return caller.runId;
  const origin = context.externalActionExecutionAuthorization?.binding.workflowActionOrigin;
  return origin && origin.requestId === context.actionRequestId ? origin.runId : undefined;
}

/** Resolve native placement from the admitted exact leaf or the incumbent Run owner. */
async function isNativeMachineSetupApply(input: MachineSetupApplyInputV1, context: ActionExecutorContext,
  readDeps: () => ActionExecutorDeps): Promise<boolean> {
  const target = input.targets[0];
  if (input.targets.length !== 1 || !target || input.machineId !== target.machineId || input.homeId !== target.homeId)
    return false;
  const hasApps = machineSetupTargetHasApps(target);
  const binding = context.externalActionExecutionAuthorization?.binding;
  // This is the existing Home-issued fresh-creation tuple. The native owner
  // still resolves its exact saved snapshot and current Machine admission.
  if (!hasApps && binding?.managedContinuation && binding.actionId === 'machines.setup.apply'
    && binding.requestId === context.actionRequestId && binding.machineId === target.machineId
    && binding.serverIdentityId === target.homeId && binding.target.kind === 'machine'
    && binding.target.machineId === target.machineId) return true;
  const admittedChild = readHostAdmittedReviewedChildV1(context);
  // Home has already bound this install-only child to its accepted Run.
  // Spend that exact leaf without reading the requester's Run as the custodian.
  if (binding && admittedChild && isReviewedMachineSetupCodecV1(binding)
    && admittedChild.actionId === binding.workflowActionOrigin?.reviewedChild?.actionId
    && admittedChild.role === binding.workflowActionOrigin.reviewedChild.role
    && admittedChild.inputDigest === binding.workflowActionOrigin.reviewedChild.inputDigest
    && sameStrictJsonValue(admittedChild.input, input)
    && binding.accountId === context.runtimeAccountId
    && binding.requestId === context.actionRequestId
    && binding.workflowActionOrigin?.requestId === binding.requestId
    && binding.machineId === target.machineId && binding.serverIdentityId === target.homeId
    && binding.target.kind === 'machine' && binding.target.machineId === target.machineId
    && binding.workflowActionOrigin.reviewedChild?.inputDigest
      === computeActionInputApprovalDigestV1(MACHINE_SETUP_APPLY_ACTION_ID_V1, input)) return true;
  const runId = readMachineSetupAcceptedRunId(context);
  const read = readDeps().readApprovedOperation;
  if (!runId || !read) return false;
  const approved = await read({ runId, actionId: 'machines.setup.apply', input, context, phase: 'dispatch' }).catch(() => null);
  context.signal?.throwIfAborted();
  if (!approved?.steps.some(step => step.actionId === 'machines.setup.apply' && sameStrictJsonValue(step.input, input)))
    return false;
  if (!hasApps) return true;
  const parent = approved.parent.actionId === 'machines.setup.apply'
    ? MachineSetupApplyInputV1Schema.safeParse(approved.parent.input) : null;
  return Boolean(parent?.success
    && parent.data.targets.some(reviewed => sameStrictJsonValue(buildMachineSetupTargetApplyInput(reviewed), input)));
}

/** Forward the source host's reviewed Backup receiver Setup Apply over Machine RPC
 * so the named receiver composes and owns its combined Setup Workflow Run. */
function isBackupReceiverSetupApplyRemoteForward(
  input: MachineSetupApplyInputV1,
  context: ActionExecutorContext,
  localMachineId?: string,
): boolean {
  const target = input.targets[0];
  const binding = context.externalActionExecutionAuthorization?.binding;
  const child = readHostAdmittedReviewedChildV1(context);
  if (!binding || !child || readHostReviewedChildReceivingAdmissionV1(context) !== null) return false;
  if (input.targets.length !== 1 || !target || input.machineId !== target.machineId || input.homeId !== target.homeId)
    return false;
  if (binding.machineId === target.machineId || localMachineId === target.machineId) return false;
  return child.actionId === BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply.action
    && child.role === BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply.role
    && sameStrictJsonValue(child.input, input)
    && isBackupReceiverSetupChildOperandV1({
      binding,
      reviewedChild: child,
      machineId: target.machineId,
      params: input,
    });
}

/** Only a freshly opened exact reviewed leaf, issued creation continuation, or remote Backup receiver child dispatches via native. */
export function createMachineSetupApplyDispatcher(params: Readonly<{
  readDeps(): ActionExecutorDeps;
  localMachineId?: string;
  native: NonNullable<ActionExecutorDeps['machineSetupApply']>;
  compose: NonNullable<ActionExecutorDeps['machineSetupApply']>;
}>): NonNullable<ActionExecutorDeps['machineSetupApply']> {
  return async request => isBackupReceiverSetupApplyRemoteForward(request.input, request.context, params.localMachineId)
    || await isNativeMachineSetupApply(request.input, request.context, params.readDeps)
    ? params.native(request) : params.compose(request);
}

/** Setup leaves release their native custody before independently admitted app leaves. */
export function buildMachineSetupWorkflow(input: MachineSetupApplyInputV1): WorkflowDefinitionV1 {
  const blocks: WorkflowActionLeafV1[] = [];
  const append = (id: string, actionId: WorkflowActionLeafV1['actionId'], value: object) => {
    blocks.push({ kind: 'action', id, actionId, input: Object.fromEntries(Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, { kind: 'literal', value: projectNativeJsonValueForTransport(field) }])) });
  };
  input.targets.forEach((target, index) => append(`setup-${index}`, 'machines.setup.apply', buildMachineSetupTargetApplyInput(target)));
  input.targets.forEach((target, targetIndex) => target.appChildren?.forEach((child, childIndex) =>
    append(`app-${targetIndex}-${childIndex}`, child.actionId, child.input)));
  return { version: 1, defaults: {}, inputs: [], blocks };
}

/** Finite composition only: Run owns acceptance, signing, persistence and recovery. */
export function createCombinedMachineSetupActionDeps(host: Readonly<{
  readDeps(): ActionExecutorDeps;
  targetPlan: NonNullable<ActionExecutorDeps['machineSetupPlan']>;
  readHostFacts(context: ActionExecutorContext, selectedMachineId?: string,
    requestedTargetMachineIds?: readonly string[]): Promise<HostFacts & Readonly<{ offlineMachineIds?: readonly string[] }>>;
  orchestrationDirectory: string;
  startCombined(request: WorkflowCombinedRunStartV1): Promise<unknown>;
  waitForRun(request: WorkflowCombinedRunStartV1): Promise<unknown>;
  readInvocations(request: WorkflowCombinedRunStartV1, read: CombinedMachineSetupInvocationRead): Promise<unknown>;
}>): Pick<ActionExecutorDeps, 'machineSetupPlan' | 'prepareMachineSetupApply' | 'machineSetupApply'> {
  const targetPlan: typeof host.targetPlan = async request => {
    let result: unknown;
    // The nested Plan retains the admitted requester context. The Machine RPC
    // transport selects its existing admitted credential path for this exact
    // reviewed child and the receiver needs the projection to admit custody.
    try { result = await host.targetPlan(request); }
    catch (error) { result = { ok: false, ...normalizeActionExecutorThrownError(error, 'machines.setup.plan') }; }
    const refused = ActionExecuteFailureSchema.safeParse(result);
    if (!refused.success || 'targets' in request.input) return result;
    const details = refused.data.details;
    return { ...refused.data, details: {
      ...(details === undefined ? {} : details && typeof details === 'object' && !Array.isArray(details)
        ? details : { cause: details }),
      target: { homeId: request.input.homeId, machineId: request.input.machineId },
    } };
  };
  const prepare = (async ({ input, context }) => {
    if (input.targets.some(target => target.homeId !== input.homeId)) return failure('server_scope_mismatch');
    const nativeLeaf = await isNativeMachineSetupApply(input, context, host.readDeps);
    const appReviews: (AppReview & Readonly<{ targetIndex: number; homeId: string; machineId: string }>)[] = [];
    const appDeployments: (AppObservation & Readonly<{ targetIndex: number; homeId: string; machineId: string }>)[] = [];
    // The target Plan's own script review, so the approval shows exactly the scripts this Apply runs.
    const scripts: Readonly<{ targetIndex: number; homeId: string; machineId: string;
      review: Pick<MachineSetupPlanReviewV1, 'steps' | 'presetUpdateEffects'>;
      resolvedSources?: MachineSetupPlanResultV1['resolvedSources'] }>[] = [];
    for (const [targetIndex, target] of input.targets.entries()) {
      if (context.signal?.aborted) return failure('cancelled');
      let exclusions = target.exclusions ?? [];
      let observedPlan: MachineSetupPlanResultV1 | undefined;
      const opaqueSources = target.sources.some(source => source.kind === 'accountPresetOpaque');
      if (!nativeLeaf && (opaqueSources || target.removeItemKeys !== undefined || target.exclusions === undefined
        || machineSetupTargetHasApps(target))) {
        const requestedExclusions = target.exclusions;
        const result = await targetPlan({ input: machineSetupPlanInputFromApplyTargetV1(target),
        context, ...(context.signal ? { signal: context.signal } : {}) });
        if (context.signal?.aborted) return failure('cancelled');
        const refused = ActionExecuteFailureSchema.safeParse(result);
        if (refused.success) return refused.data;
        const observed = MachineSetupPlanResultV1Schema.safeParse(result);
        if (!observed.success) return failure('invalid_action_output');
        if (observed.data.desiredRevision !== target.desiredRevision || !sameStrictJsonValue(observed.data.sources, target.sources)
          || !sameStrictJsonValue(observed.data.candidatePreset, target.candidatePreset)
          || !sameStrictJsonValue(observed.data.removeItemKeys, target.removeItemKeys)
          || requestedExclusions !== undefined && !sameStrictJsonValue(observed.data.exclusions, requestedExclusions)) return failure('plan_changed');
        exclusions = observed.data.exclusions;
        observedPlan = observed.data;
        const review = observedPlan.review;
        if (review?.presetUpdateEffects) scripts.push({ targetIndex, homeId: target.homeId, machineId: target.machineId,
          review: { ...(review.steps ? { steps: review.steps } : {}), presetUpdateEffects: review.presetUpdateEffects },
          // The reviewer's own recipient projections, so the approval opens exactly what Setup Review opens.
          ...(observedPlan.resolvedSources ? { resolvedSources: observedPlan.resolvedSources } : {}) });
      }
      if (opaqueSources) {
        // The target owns private source opening and native review. An already
        // admitted exact leaf spends its signed review; roots compare the fresh
        // target Plan without recreating private recipes in the composer.
        if (!nativeLeaf && !sameStrictJsonValue(observedPlan?.recipePlans ?? [], target.recipePlans)) return failure('plan_changed');
      } else {
      const allRecipes = selectMachineSetupRecipeItemsV1(target.sources.filter(source => source.kind !== 'accountPresetOpaque').map(source => source.setup), exclusions)
        .map(({ sourceIndex, itemIndex, item }) => ({ sourceIndex, itemIndex, selection: item.selection }));
      // Update uses the exact freshly rechecked subset at original coordinates.
      const recipes = target.removeItemKeys === undefined ? allRecipes : target.recipePlans.map(plan =>
        allRecipes.find(recipe => recipe.sourceIndex === plan.sourceIndex && recipe.itemIndex === plan.itemIndex));
      if (recipes.length !== target.recipePlans.length || recipes.some((recipe, index) => {
        const reviewed = target.recipePlans[index];
        return !recipe || !reviewed || recipe.sourceIndex !== reviewed.sourceIndex || recipe.itemIndex !== reviewed.itemIndex
          || reviewed.plan.basis.kind !== 'setup' || reviewed.plan.basis.machineId !== target.machineId
          || reviewed.plan.basis.desiredRevision !== target.desiredRevision
          || !sameStrictJsonValue(reviewed.plan.basis.selection, recipe.selection);
      })) return failure('machine_setup_plan_required');
      }
      // This exact accepted native leaf retains desired app intent, but does
      // not prepare or execute it. Separate app leaves keep their own fresh
      // requester custody and deployment preflight. Roots dispatch only newly
      // authored apps; retained outcomes belong to their existing Run recovery.
      const admitted = nativeLeaf || !observedPlan ? { reviews: [], apps: [], appChildren: target.appChildren ?? [] }
        : { reviews: observedPlan.appReviews ?? [], apps: observedPlan.review?.apps ?? [],
          appChildren: observedPlan.appChildren ?? [] };
      // Preparation cannot silently change the executable subset already shown
      // in Plan and included in the exact reviewed parent input.
      if (!sameStrictJsonValue(admitted.appChildren, target.appChildren ?? [])) return failure('plan_changed');
      appReviews.push(...admitted.reviews.map(review => ({ targetIndex,
        homeId: target.homeId, machineId: target.machineId, ...review })));
      appDeployments.push(...admitted.apps.map(app => ({ targetIndex,
        homeId: target.homeId, machineId: target.machineId, ...app })));
    }
    let facts: HostFacts;
    try { facts = await host.readHostFacts(context, input.machineId); }
    catch (error) {
      if (context.signal?.aborted) return failure('cancelled');
      return { ok: false, ...normalizeActionExecutorThrownError(error, 'machines.setup.apply') };
    }
    if (context.signal?.aborted) return failure('cancelled');
    const selected = resolveCombinedActionWorkflowHostV1({ actionId: 'machines.setup.apply', ...facts,
      targetMachineIds: input.targets.map(target => target.machineId), selectedMachineId: input.machineId });
    if (selected.kind !== 'ready') return failure('machine_unavailable');
    return { input, host: selected, preview: { kind: 'machineSetup', host: projectNativeJsonValueForTransport(selected.review),
      targets: projectNativeJsonValueForTransport(input.targets), appReviews: projectNativeJsonValueForTransport(appReviews),
      appDeployments: projectNativeJsonValueForTransport(appDeployments),
      scripts: projectNativeJsonValueForTransport(scripts),
      childCount: buildMachineSetupWorkflow(input).blocks.length } };
  }) satisfies Preparation;
  return {
    prepareMachineSetupApply: prepare,
    machineSetupPlan: async request => {
      if (!('targets' in request.input)) {
        const result = await targetPlan(request);
        if (!request.input.mode) return result;
        const plan = MachineSetupPlanResultV1Schema.safeParse(result);
        if (!plan.success || !plan.data.review) return result;
        const observed = plan.data;
        // Host choices use the same captured Account roster and policy as the
        // combined review. Optional enrichment must not gate a native Plan.
        const facts = await host.readHostFacts(request.context).catch(() => undefined);
        if (request.signal?.aborted || request.context.signal?.aborted) return failure('cancelled');
        if (!facts) return observed;
        const selected = resolveCombinedActionWorkflowHostV1({ actionId: 'machines.setup.apply', ...facts,
          targetMachineIds: [request.input.machineId] });
        return { ...observed, review: { ...plan.data.review, host: selected.review } } satisfies MachineSetupPlanResultV1;
      }
      const input = MachineSetupCombinedPlanInputV1Schema.parse(request.input);
      if (input.targets.some(target => target.homeId !== input.homeId)) return failure('server_scope_mismatch');
      const facts = await host.readHostFacts(request.context, input.selectedMachineId, input.targets.map(target => target.machineId));
      if (request.signal?.aborted || request.context.signal?.aborted) return failure('cancelled');
      const offline = new Set(facts.offlineMachineIds ?? []);
      // Distinct Machines can start their read-only plans together. Consume them
      // in the requested order so a refusal can settle before later plans.
      const observations = input.targets.map(target =>
        offline.has(target.machineId) ? undefined : targetPlan({ ...request, input: target }));
      const targets: MachineSetupCombinedPlanResultV1['targets'] = [];
      for (const [index, target] of input.targets.entries()) {
        if (request.signal?.aborted || request.context.signal?.aborted) return failure('cancelled');
        if (offline.has(target.machineId)) {
          targets.push({ homeId: target.homeId, machineId: target.machineId,
            status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' });
          continue;
        }
        const result = await observations[index];
        if (request.signal?.aborted || request.context.signal?.aborted) return failure('cancelled');
        const refused = ActionExecuteFailureSchema.safeParse(result);
        if (refused.success) {
          if (refused.data.errorCode !== 'machine_offline') return refused.data;
          targets.push({ homeId: target.homeId, machineId: target.machineId,
            status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' });
          continue;
        }
        const plan = MachineSetupPlanResultV1Schema.safeParse(result);
        if (!plan.success) return failure('invalid_action_output');
        targets.push({ homeId: target.homeId, machineId: target.machineId, plan: plan.data,
          ...(plan.data.appChildren === undefined ? {} : { appChildren: plan.data.appChildren }) });
      }
      if (request.signal?.aborted || request.context.signal?.aborted) return failure('cancelled');
      const ready = targets.filter(target => 'plan' in target);
      if (!ready.length) return MachineSetupCombinedPlanResultV1Schema.parse({ targets,
        review: { machineId: null, machines: facts.machines } });
      const selected = resolveCombinedActionWorkflowHostV1({ actionId: 'machines.setup.apply', ...facts,
        targetMachineIds: ready.map(target => target.machineId), selectedMachineId: input.selectedMachineId });
      if (selected.kind !== 'ready') return failure('machine_unavailable');
      return MachineSetupCombinedPlanResultV1Schema.parse({ targets, review: selected.review });
    },
    machineSetupApply: async ({ input, context }) => {
      const prepared = await prepare({ input, context });
      if ('errorCode' in prepared) return prepared;
      const reviewed = prepared.input;
      const { machineId } = prepared.host;
      const acceptance = context.operationAcceptance;
      if (!acceptance || acceptance.actionId !== 'machines.setup.apply' || !context.runtimeAccountId || !context.actionRequestId)
        return failure('admission_unavailable');
      const binding = context.externalActionExecutionAuthorization?.binding;
      const reviewedChild = binding ? readHostAdmittedReviewedChildV1(context) : null;
      const backupRunId = binding && reviewedChild ? deriveBackupReceiverSetupRunIdV1(binding, reviewedChild) : null;
      const runId = backupRunId ?? deriveMachineSetupCombinedRunIdV1({ homeId: binding?.serverIdentityId ?? reviewed.homeId,
        accountId: binding?.accountId ?? context.runtimeAccountId,
        requestId: binding?.requestId ?? context.actionRequestId,
        ...(reviewedChild ? { reviewedChild } : {}) });
      const target = context.externalActionTarget;
      // A nested Run keeps its existing exact same-host project binding. The
      // Run owner still rejects a different Machine or incompatible target.
      const orchestrationTarget = target?.kind === 'machine' && target.machineId === machineId
        && target.project?.machineId === machineId ? target.project
        : { machineId, directory: host.orchestrationDirectory };
      const request: WorkflowCombinedRunStartV1 = { parent: { actionId: 'machines.setup.apply', input: reviewed },
        start: { runId, executionTarget: { kind: 'session' },
          source: prepareWorkflowRunStartV1({ definition: buildMachineSetupWorkflow(reviewed) }).source },
        context, orchestrationTarget };
      const started = await host.startCombined(request);
      const refused = ActionExecuteFailureSchema.safeParse(started);
      if (refused.success) return refused.data;
      if (!WorkflowActionOutputSchemasV1['workflow.run.start'].safeParse(started).success)
        return failure('machine_setup_unavailable');
      context.operationOwnerUpdate?.update({ cancellation: 'unsupported' });
      const result = { operationId: acceptance.operationId, runId };
      acceptance.accept(result);
      const hasReceivers = reviewed.targets.some(target => target.recipePlans.some(entry =>
        entry.plan.basis.kind === 'setup' && entry.plan.basis.selection
          && isBackupReceiverSelection(entry.plan.basis.selection)));
      const withRecovery = (value: ActionExecuteFailure): ActionExecuteFailure => {
        if (!hasReceivers) return value;
        const details = value.details;
        return { ...value, details: {
          ...(details === undefined ? {} : details && typeof details === 'object' && !Array.isArray(details)
            ? details : { childResult: details }),
          setupOperation: result,
        } };
      };
      // Losing the observer does not settle the Run or release its native child.
      // The existing Run remains the recovery/cancellation owner.
      const uncertain = (cause?: ActionExecuteFailure): ActionExecuteFailure => withRecovery({
        ok: false, errorCode: context.signal?.aborted ? 'stop_unconfirmed' : 'outcome_uncertain',
        error: 'Setup has no confirmed terminal outcome. Its child may still be changing the Machine. Open the Workflow Run to cancel or recover it before retrying.',
        details: { runId, ...(cause ? { observationFailure: cause } : {}) },
        ...(cause ? { failureCause: cause.failureCause ?? projectActionFailureCauseV1(cause, 'workflow.run.wait') } : {}),
      });
      let observed: unknown;
      try { observed = await host.waitForRun(request); }
      catch (error) { return uncertain({ ok: false, ...normalizeActionExecutorThrownError(error, 'workflow.run.wait') }); }
      const waitFailure = ActionExecuteFailureSchema.safeParse(observed);
      if (waitFailure.success) return uncertain(waitFailure.data);
      const settled = WorkflowRunWaitSnapshotV1Schema.safeParse(observed);
      if (!settled.success) return uncertain({ ok: false,
        ...normalizeActionExecutorThrownError(settled.error, 'workflow.run.wait') });
      const { run } = settled.data;
      if (run.workflowCustodyState !== 'settled' && run.state !== 'interrupted') return uncertain();
      const succeeded = run.state === 'succeeded';
      if (succeeded && !hasReceivers) return result;
      if (run.state === 'cancelled') return withRecovery(failure('cancelled'));
      // Retained Setup invocations own receiver evidence. Failed Runs retain
      // their typed failure and native details at the same content boundary.
      let cursor: string | undefined;
      const backupReceivers: NonNullable<ReturnType<typeof MachineSetupApplyResultV1Schema.parse>['backupReceivers']> = [];
      const setupBlocks = new Set(reviewed.targets.map((_, index) => `setup-${index}`));
      do {
        let observed: unknown;
        try { observed = await host.readInvocations(request, { actionId: 'workflow.run.invocations.list', input: {
          runId, lifecycles: [succeeded ? 'completed' : 'failed'], includeContent: true, ...(cursor ? { cursor } : {}),
        } }); }
        catch (error) { return withRecovery({ ok: false, ...normalizeActionExecutorThrownError(error, 'workflow.run.invocations.list') }); }
        const refused = ActionExecuteFailureSchema.safeParse(observed);
        if (refused.success) return withRecovery(refused.data);
        const page = WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].safeParse(observed);
        if (!page.success) return withRecovery({ ok: false,
          ...normalizeActionExecutorThrownError(page.error, 'workflow.run.invocations.list') });
        if (!page.data.invocationDetails) return withRecovery(failure('content_unavailable'));
        for (const { index, progress } of page.data.invocationDetails) {
          if (progress.blockKind !== 'action') continue;
          if (succeeded) {
            if (!setupBlocks.has(progress.invocationPath.blockId) || progress.invocationPath.scope.length) continue;
            const completed = ActionOperationCompletionOutputV1Schema.safeParse(progress.result);
            const child = MachineSetupApplyResultV1Schema.safeParse(completed.success ? completed.data.operation.result : progress.result);
            if (!child.success) return withRecovery(failure('invalid_action_output'));
            backupReceivers.push(...(child.data.backupReceivers ?? []));
            continue;
          }
          if (!progress.reason) continue;
          const completed = ActionOperationCompletionOutputV1Schema.safeParse(progress.result);
          const child = completed.success ? completed.data.operation : undefined;
          const attachment = child?.domainRef;
          const childDetails = child?.error?.details;
          let details = child ? childDetails : progress.result;
          if (child?.actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1 && attachment?.kind === 'machineSetup'
            && childDetails && 'kind' in childDetails && childDetails.kind === 'finiteCommand') {
            details = { ...childDetails, failedSetupOperation: {
              operationId: child.operationId, serverId: attachment.serverId, machineId: attachment.machineId,
              ...(attachment.terminalId === undefined ? {} : { terminalId: attachment.terminalId }),
            } };
          }
          let setupRetry: MachineSetupRetryV1 | undefined;
          if (run.state === 'interrupted') {
            const input = { runId, invocationId: index.id };
            // Only the exact Workflow detail owns Retry availability.
            const detail = await host.readInvocations(request, { actionId: 'workflow.run.invocations.get', input }).catch(() => null);
            setupRetry = readMachineSetupWorkflowRetry(input, detail);
          }
          return withRecovery({ ok: false, errorCode: progress.reason.code, error: progress.reason.message ?? progress.reason.code,
            ...(progress.reason.failureCause ? { failureCause: progress.reason.failureCause } : {}),
            ...(details === undefined ? {} : { details }),
            ...(setupRetry ? { setupRetry } : {}) });
        }
        cursor = page.data.nextCursor;
      } while (cursor);
      return succeeded ? { ...result, ...(backupReceivers.length ? { backupReceivers } : {}) }
        : run.state === 'interrupted' ? uncertain() : withRecovery(failure(run.errorCode ?? 'machine_setup_child_failed'));
    },
  };
}
