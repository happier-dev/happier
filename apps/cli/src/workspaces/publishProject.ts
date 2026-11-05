import { DeploymentPublishInputV1Schema, DeploymentPublishPrepareInputV1Schema, DeploymentPublishPrepareResultV1Schema, type DeploymentPublishPrepareInputV1, type DeploymentPublishPrepareResultV1, type DeploymentTemplateV1, type ActionExecutorContext, type ActionExecutorDeps, type DeploymentPublishInputV1, type DeploymentPublishResultV1, type WorkflowActionExecuteArgs, deriveWorkflowReplacementId } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentDeployInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { WorkflowCombinedRunStartV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { projectNativeJsonValueForTransport, sameStrictJsonValue, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { prepareWorkflowRunStartV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowActionLeafV1, WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import { resolveDeploymentCreationDefaultsV1 } from '@happier-dev/deployments';
import type { DeploymentCreationDefaultInputsForHost } from '@/deployments/readCreationDefaultsForHost';
import { machineSetupTargetHasApps } from '@/machines/setup/composeMachineSetup';

type PublishPreparation = NonNullable<ActionExecutorDeps['prepareDeploymentPublish']>;
type PublishHostFacts = Exclude<Awaited<ReturnType<PublishPreparation>>, ActionExecuteFailure>['host'];
export type PublishWorkflowStart = WorkflowCombinedRunStartV1;
export type PublishWorkflowInvocationRead = WorkflowActionExecuteArgs<'workflow.run.invocations.list'>['input'];

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** The catalog entry shares P45 selection and P40 defaults; it cannot create an effect operand. */
export function createPublishCatalogPreparation(host: Readonly<{
  readSelection(input: DeploymentPublishPrepareInputV1, context: ActionExecutorContext): Promise<Readonly<{
    source?: ProjectSourceV1;
    newProject?: DeploymentPublishPrepareInputV1['newProject'];
    template: DeploymentTemplateV1;
    defaultInputs: DeploymentCreationDefaultInputsForHost;
  }>>;
}>) {
  return async (raw: DeploymentPublishPrepareInputV1, context: ActionExecutorContext): Promise<DeploymentPublishPrepareResultV1 | ActionExecuteFailure> => {
    try {
      const input = DeploymentPublishPrepareInputV1Schema.parse(raw);
      const selected = await host.readSelection(input, context);
      if (input.newProject ? !sameStrictJsonValue(input.newProject, selected.newProject)
        : selected.source?.id !== input.projectSourceId || selected.source?.revision !== input.sourceRevision) return failure('source_changed');
      const owner = selected.newProject?.owner ?? selected.source?.owner
        ?? (selected.source ? { kind: 'account' as const, accountId: selected.source.createdByAccountId } : undefined);
      if (!owner) return failure('source_changed');
      const creationDefaults = resolveDeploymentCreationDefaultsV1({ projectSourceId: input.projectSourceId,
        projectOwner: owner, ...selected.defaultInputs, explicit: input.explicit,
        target: { kind: 'ownServer', machines: [input.machineId] } });
      context.signal?.throwIfAborted();
      return DeploymentPublishPrepareResultV1Schema.parse({ kind: 'prepared', templateRef: input.templateRef,
        project: selected.newProject ? { newProject: selected.newProject, owner }
          : { projectSourceId: selected.source?.id, sourceRevision: selected.source?.revision, owner },
        machine: { machineId: input.machineId, installationId: input.installationId }, template: selected.template,
        creationDefaults, ...(selected.defaultInputs.reviewBasis ? { creationDefaultsBasis: selected.defaultInputs.reviewBasis } : {}) });
    } catch (error) {
      return failure(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : 'deployment_unavailable');
    }
  };
}

function hasConcretePublishInputs(input: DeploymentPublishInputV1): boolean {
  const children = input.preparedChildren;
  return input.project.kind === 'existing' && input.environment.kind === 'existing'
    && !children.acquire?.length && !children.runtimeLink && !children.dataLinks?.length && !children.bindings
    && !children.setup?.some(setup => setup.targets.some(machineSetupTargetHasApps));
}

/** Only registered, concretely reviewed owner operands become Workflow leaves. */
export function buildPublishWorkflow(input: DeploymentPublishInputV1): WorkflowDefinitionV1 {
  if (!hasConcretePublishInputs(input)) throw Object.assign(new Error('deployment_unavailable'), { code: 'deployment_unavailable' });
  const blocks: WorkflowActionLeafV1[] = [];
  const append = (id: string, actionId: 'machines.managed.retention.update' | 'machines.setup.apply' | 'deployments.deploy', value: object) => {
    blocks.push({ kind: 'action', id, actionId, input: Object.fromEntries(Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, { kind: 'literal', value: projectNativeJsonValueForTransport(field) }])) });
  };
  input.preparedChildren.retention?.forEach((value, index) => append(`retention-${index}`, 'machines.managed.retention.update', value));
  input.preparedChildren.setup?.forEach((value, index) => append(`setup-${index}`, 'machines.setup.apply', value));
  append('deploy', 'deployments.deploy', input.preparedChildren.deploy);
  return { version: 1, defaults: {}, inputs: [], blocks };
}

/**
 * Finite Publish composition. Reads remain at their existing Home/Artifact
 * owners; admission, persistence, scheduling and recovery remain Run-owned.
 */
export function createPublishProjectActionDeps(host: Readonly<{
  prepareDeploymentAction?: NonNullable<ActionExecutorDeps['prepareDeploymentAction']>;
  readHostFacts(context: ActionExecutorContext, selectedMachineId?: string): Promise<PublishHostFacts>;
  orchestrationDirectory: string;
  startCombined(request: PublishWorkflowStart): Promise<unknown>;
  waitForRun(request: PublishWorkflowStart): Promise<unknown>;
  readInvocations(request: PublishWorkflowStart, input: PublishWorkflowInvocationRead): Promise<unknown>;
}>): Pick<ActionExecutorDeps, 'prepareDeploymentPublish' | 'deploymentPublish'> {
  const prepare: PublishPreparation = async ({ input: raw, context }) => {
    const input = DeploymentPublishInputV1Schema.parse(raw);
    // Workflow result references already exist; these branches still need
    // canonical child admission for result-derived operands. Never manufacture
    // ids/revisions or grant later children consent here.
    if (!hasConcretePublishInputs(input) || input.project.kind !== 'existing' || input.environment.kind !== 'existing') {
      return failure('deployment_unavailable');
    }
    if (!host.prepareDeploymentAction) return failure('deployment_unavailable');
    // The parent Ask consumes the child's real review once. Run admission
    // retains the exact witnessed parent and its materialized child operands.
    const deployment = await invokeHostReviewedChildV1({ parent: { actionId: 'deployments.publish',
      input: projectNativeJsonValueForTransport(input) as Record<string, JsonValue> }, context,
      child: { action: 'deployments.deploy', role: 'publish.deploy',
        input: projectNativeJsonValueForTransport(input.preparedChildren.deploy) },
      // Preparation carries exact custody, not admitted policy or permission to execute.
      execute: (childInput, childContext) => host.prepareDeploymentAction!({ actionId: 'deployments.deploy',
        input: DeploymentDeployInputV1Schema.parse(childInput), context: childContext }) });
    if ('errorCode' in deployment) return deployment;
    if ('observePendingOperation' in deployment) return failure('invalid_action_output');
    if (!sameStrictJsonValue(deployment.input, input.preparedChildren.deploy)) return failure('approval_stale');
    const facts = await host.readHostFacts(context, input.hostMachineId ?? undefined);
    return { input, host: facts,
      preview: { kind: 'deploymentPublish',
        hostMachineId: input.hostMachineId, childCount: buildPublishWorkflow(input).blocks.length,
        deployment: deployment.preview } };
  };
  return {
    prepareDeploymentPublish: prepare,
    deploymentPublish: async (input, context) => {
      const machineId = input.hostMachineId;
      if (!machineId) {
        return { kind: 'refused', reason: 'target_unavailable' };
      }
      const acceptance = context.operationAcceptance;
      if (!acceptance || acceptance.actionId !== 'deployments.publish' || !context.runtimeAccountId) return failure('deployment_unavailable');
      const runId = deriveWorkflowReplacementId(['deployments.publish', input.serverId, context.runtimeAccountId, input.requestKey]);
      const request: PublishWorkflowStart = { parent: { actionId: 'deployments.publish', input },
        start: { runId, executionTarget: { kind: 'session' },
          source: prepareWorkflowRunStartV1({ definition: buildPublishWorkflow(input) }).source },
        context, orchestrationTarget: { machineId, directory: host.orchestrationDirectory } };
      const admitted = await host.startCombined(request);
      if (!WorkflowActionOutputSchemasV1['workflow.run.start'].safeParse(admitted).success) return failure('deployment_unavailable');
      const result = { kind: 'started' as const, operationRef: { serverId: input.serverId, machineId, operationId: acceptance.operationId } };
      acceptance.accept(result);
      // Keep the real Action operation attached to the Run's pushed terminal
      // observation, rather than completing on mere child admission.
      const childOperationRefs: Extract<DeploymentPublishResultV1, { kind: 'partial' }>['childOperationRefs'] = [];
      const recovery = { operationRef: result.operationRef, childOperationRefs };
      const uncertain = (cause?: ActionExecuteFailure): ActionExecuteFailure => ({
        ok: false, errorCode: context.signal?.aborted ? 'stop_unconfirmed' : 'outcome_uncertain',
        error: 'Publish is still owned by its Workflow Run. Its outcome could not be observed; cancel that Run before retrying.',
        details: { ...recovery, runId, ...(cause ? { observationFailure: cause } : {}) },
        ...(cause?.failureCause ? { failureCause: cause.failureCause } : {}),
      });
      let observed: unknown;
      try { observed = await host.waitForRun(request); }
      catch (error) { observed = { ok: false, ...normalizeActionExecutorThrownError(error, 'workflow.run.wait') }; }
      const waitFailure = ActionExecuteFailureSchema.safeParse(observed);
      const settled = WorkflowActionOutputSchemasV1['workflow.run.wait'].safeParse(observed);
      const terminal = settled.success && settled.data.observation === 'terminal';
      const readPage = async (input: PublishWorkflowInvocationRead) => {
        const result = await host.readInvocations(request, input);
        const refused = ActionExecuteFailureSchema.safeParse(result);
        if (refused.success) throw Object.assign(new Error(refused.data.errorCode), { code: refused.data.errorCode });
        return WorkflowActionOutputSchemasV1['workflow.run.invocations.list'].parse(result);
      };
      try {
        // Publish authors a flat finite Workflow. Read its history headers for
        // all roots, then only their direct-child content, including retained
        // attempts; never infer completed effects from parent state.
        const rootIds: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await readPage({ runId, ...(cursor ? { cursor } : {}) });
          rootIds.push(...page.invocations.filter(invocation => invocation.parentRecordId === null).map(invocation => invocation.id));
          cursor = page.nextCursor;
        } while (cursor);
        if (rootIds.length) {
          const seen = new Set<string>();
          do {
            const page = await readPage({ runId, parentRecordIds: rootIds, includeContent: true,
              ...(cursor ? { cursor } : {}) });
            if (!page.invocationDetails) return terminal
              ? { ...failure('outcome_unknown'), details: recovery } : uncertain(failure('outcome_unknown'));
            for (const { progress } of page.invocationDetails) {
              if (progress.execution?.kind !== 'action') continue;
              for (const { serverId, machineId, operationId } of progress.execution.awaitedOperations ?? []) {
                const ref = { serverId, machineId, operationId };
                const key = JSON.stringify(ref);
                if (!seen.has(key)) { seen.add(key); childOperationRefs.push(ref); }
              }
            }
            cursor = page.nextCursor;
          } while (cursor);
        }
      } catch (error) {
        const cause = { ok: false as const, ...normalizeActionExecutorThrownError(error, 'workflow.run.invocations.list') };
        return terminal ? { ...cause, details: recovery } : uncertain(cause);
      }
      if (waitFailure.success) return uncertain(waitFailure.data);
      if (!settled.success) return uncertain({ ok: false,
        ...normalizeActionExecutorThrownError(settled.error, 'workflow.run.wait') });
      if (settled.data.observation !== 'terminal') return uncertain();
      if (settled.data.run.state !== 'succeeded') {
        const errorCode = settled.data.run.state === 'cancelled' ? 'cancelled' : 'deployment_child_failed';
        context.operationOwnerUpdate?.update({ outcome: { ...failure(errorCode), details: recovery } });
        return { kind: 'partial', operationRef: result.operationRef,
          childOperationRefs, reason: settled.data.run.state === 'cancelled' ? 'cancelled' : 'child_failed' };
      }
      return { ...result, childOperationRefs };
    },
  };
}
