import { MachineSetupApplyInputV1Schema, MachineSetupCombinedPlanInputV1Schema, MachineSetupCombinedPlanResultV1Schema, MachineSetupPlanResultV1Schema, admitCombinedActionWorkflowHostV1, resolveCombinedActionWorkflowHostV1, deriveWorkflowReplacementId, prepareWorkflowRunStartV1, type ActionExecutorContext, type ActionExecutorDeps, type MachineSetupApplyInputV1, type MachineSetupApplyTargetV1, type MachineSetupCombinedPlanResultV1, type WorkflowActionExecuteArgs } from '@happier-dev/protocol';
import { selectMachineSetupRecipeItemsV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { MachineSetupPlanResultV1, MachineSetupPlanReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WorkflowCombinedRunStartV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import type { WorkflowActionLeafV1, WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

type Preparation = NonNullable<ActionExecutorDeps['prepareMachineSetupApply']>;
type HostFacts = Exclude<Awaited<ReturnType<Preparation>>, ActionExecuteFailure>['host'];
type AppReview = NonNullable<MachineSetupPlanResultV1['appReviews']>[number];
type AppObservation = NonNullable<MachineSetupPlanReviewV1['apps']>[number];
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Keep desired intent, item indices and reviewed app operands unchanged at the native leaf. */
export function buildMachineSetupTargetApplyInput(target: MachineSetupApplyTargetV1): MachineSetupApplyInputV1 {
  return { homeId: target.homeId, machineId: target.machineId, targets: [target] };
}

/** Authored apps and their reviewed children both require the Setup app flow. */
export function machineSetupTargetHasApps(target: MachineSetupApplyTargetV1): boolean {
  return Boolean(target.appChildren?.length)
    || target.sources.some(source => source.setup.items?.some(item => item.kind === 'app'));
}

/** Re-read the same exact native-leaf proof independently at preparation and dispatch. */
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
  const runId = binding?.workflowActionOrigin?.runId
    ?? (context.actionCaller?.kind === 'workflowRun' && context.executionRunWorkflowRunId === context.actionCaller.runId
      ? context.actionCaller.runId : undefined);
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

/** Only a freshly opened exact reviewed leaf or issued creation continuation is native. */
export function createMachineSetupApplyDispatcher(params: Readonly<{
  readDeps(): ActionExecutorDeps;
  native: NonNullable<ActionExecutorDeps['machineSetupApply']>;
  compose: NonNullable<ActionExecutorDeps['machineSetupApply']>;
}>): NonNullable<ActionExecutorDeps['machineSetupApply']> {
  return async request => await isNativeMachineSetupApply(request.input, request.context, params.readDeps)
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
  readInvocations(request: WorkflowCombinedRunStartV1,
    input: WorkflowActionExecuteArgs<'workflow.run.invocations.list'>['input']): Promise<unknown>;
}>): Pick<ActionExecutorDeps, 'machineSetupPlan' | 'prepareMachineSetupApply' | 'machineSetupApply'> {
  const prepare: Preparation = async ({ input: raw, context }) => {
    const input = MachineSetupApplyInputV1Schema.parse(raw);
    if (input.targets.some(target => target.homeId !== input.homeId)) return failure('server_scope_mismatch');
    const nativeLeaf = await isNativeMachineSetupApply(input, context, host.readDeps);
    const appReviews: (AppReview & Readonly<{ targetIndex: number; homeId: string; machineId: string }>)[] = [];
    const appDeployments: (AppObservation & Readonly<{ targetIndex: number; homeId: string; machineId: string }>)[] = [];
    for (const [targetIndex, target] of input.targets.entries()) {
      if (context.signal?.aborted) return failure('cancelled');
      let exclusions = target.exclusions ?? [];
      let observedPlan: MachineSetupPlanResultV1 | undefined;
      if (!nativeLeaf && (target.removeItemKeys !== undefined || target.exclusions === undefined
        || machineSetupTargetHasApps(target))) {
        const requestedExclusions = target.exclusions;
        const result = await host.targetPlan({ input: { homeId: target.homeId, machineId: target.machineId,
          sources: target.sources, ...(requestedExclusions === undefined ? {} : { exclusions: requestedExclusions }),
          ...(target.removeItemKeys === undefined ? {} : { removeItemKeys: target.removeItemKeys }),
          ...(target.appChildren === undefined ? {} : { appChildren: target.appChildren }), mode: 'effects' },
        context, ...(context.signal ? { signal: context.signal } : {}) });
        if (context.signal?.aborted) return failure('cancelled');
        const refused = ActionExecuteFailureSchema.safeParse(result);
        if (refused.success) return refused.data;
        const observed = MachineSetupPlanResultV1Schema.safeParse(result);
        if (!observed.success) return failure('invalid_action_output');
        if (observed.data.desiredRevision !== target.desiredRevision || !sameStrictJsonValue(observed.data.sources, target.sources)
          || !sameStrictJsonValue(observed.data.recipePlans ?? [], target.recipePlans)
          || !sameStrictJsonValue(observed.data.removeItemKeys, target.removeItemKeys)
          || requestedExclusions !== undefined && !sameStrictJsonValue(observed.data.exclusions, requestedExclusions)) return failure('plan_changed');
        exclusions = observed.data.exclusions;
        observedPlan = observed.data;
      }
      const allRecipes = selectMachineSetupRecipeItemsV1(target.sources.map(source => source.setup), exclusions)
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
    const facts = await host.readHostFacts(context, input.machineId);
    if (context.signal?.aborted) return failure('cancelled');
    const selected = resolveCombinedActionWorkflowHostV1({ actionId: 'machines.setup.apply', ...facts,
      targetMachineIds: input.targets.map(target => target.machineId), selectedMachineId: input.machineId });
    if (selected.kind !== 'ready') return failure('machine_unavailable');
    return { input, host: facts, preview: { kind: 'machineSetup', host: projectNativeJsonValueForTransport(selected.review),
      targets: projectNativeJsonValueForTransport(input.targets), appReviews: projectNativeJsonValueForTransport(appReviews),
      appDeployments: projectNativeJsonValueForTransport(appDeployments),
      childCount: buildMachineSetupWorkflow(input).blocks.length } };
  };
  return {
    prepareMachineSetupApply: prepare,
    machineSetupPlan: async request => {
      if (!('targets' in request.input)) {
        const result = await host.targetPlan(request);
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
        return MachineSetupPlanResultV1Schema.parse({ ...observed,
          review: { ...observed.review, host: selected.review } });
      }
      const input = MachineSetupCombinedPlanInputV1Schema.parse(request.input);
      if (input.targets.some(target => target.homeId !== input.homeId)) return failure('server_scope_mismatch');
      const facts = await host.readHostFacts(request.context, input.selectedMachineId, input.targets.map(target => target.machineId));
      if (request.signal?.aborted || request.context.signal?.aborted) return failure('cancelled');
      const offline = new Set(facts.offlineMachineIds ?? []);
      const targets: MachineSetupCombinedPlanResultV1['targets'] = [];
      for (const target of input.targets) {
        if (request.signal?.aborted || request.context.signal?.aborted) return failure('cancelled');
        if (offline.has(target.machineId)) {
          targets.push({ homeId: target.homeId, machineId: target.machineId,
            status: 'unavailable', reason: 'offline', errorCode: 'machine_offline' });
          continue;
        }
        const result = await host.targetPlan({ ...request, input: target });
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
      if (admitCombinedActionWorkflowHostV1({ machineId: reviewed.machineId, ...prepared.host }).kind !== 'ready')
        return failure('machine_unavailable');
      const acceptance = context.operationAcceptance;
      if (!acceptance || acceptance.actionId !== 'machines.setup.apply' || !context.runtimeAccountId || !context.actionRequestId)
        return failure('admission_unavailable');
      const runId = deriveWorkflowReplacementId(['machines.setup.apply', reviewed.homeId, context.runtimeAccountId, context.actionRequestId]);
      const target = context.externalActionTarget;
      // A nested Run keeps its existing exact same-host project binding. The
      // Run owner still rejects a different Machine or incompatible target.
      const orchestrationTarget = target?.kind === 'machine' && target.machineId === reviewed.machineId
        && target.project?.machineId === reviewed.machineId ? target.project
        : { machineId: reviewed.machineId, directory: host.orchestrationDirectory };
      const request: WorkflowCombinedRunStartV1 = { parent: { actionId: 'machines.setup.apply', input: reviewed },
        start: { runId, executionTarget: { kind: 'session' },
          source: prepareWorkflowRunStartV1({ definition: buildMachineSetupWorkflow(reviewed) }).source },
        context, orchestrationTarget };
      const started = await host.startCombined(request);
      const refused = ActionExecuteFailureSchema.safeParse(started);
      if (refused.success) return refused.data;
      if (!WorkflowActionOutputSchemasV1['workflow.run.start'].safeParse(started).success)
        return failure('machine_setup_unavailable');
      const result = { operationId: acceptance.operationId, runId };
      acceptance.accept(result);
      const settled = WorkflowActionOutputSchemasV1['workflow.run.wait'].safeParse(await host.waitForRun(request));
      if (!settled.success || settled.data.observation !== 'terminal') return failure('outcome_unknown');
      if (settled.data.run.state === 'succeeded') return result;
      if (settled.data.run.state === 'cancelled') return failure('cancelled');
      // Failed Runs have no final output. Their retained Action invocation owns
      // the typed failure and native details; do not replace it with parent prose.
      let cursor: string | undefined;
      do {
        const observed = await host.readInvocations(request, { runId, lifecycles: ['failed'], includeContent: true,
          ...(cursor ? { cursor } : {}) });
        const refused = ActionExecuteFailureSchema.safeParse(observed);
        if (refused.success) return refused.data;
        const page = WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].safeParse(observed);
        if (!page.success || !page.data.invocationDetails) return failure('outcome_unknown');
        for (const { progress } of page.data.invocationDetails) {
          if (progress.blockKind !== 'action' || !progress.reason) continue;
          return { ok: false, errorCode: progress.reason.code, error: progress.reason.message ?? progress.reason.code,
            ...(progress.result === undefined ? {} : { details: progress.result }) };
        }
        cursor = page.data.nextCursor;
      } while (cursor);
      return failure('machine_setup_child_failed');
    },
  };
}
