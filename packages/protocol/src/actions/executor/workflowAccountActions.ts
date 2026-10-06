import { WorkflowActionInputSchemasV1, WorkflowActionOutputSchemasV1 } from '../../workflows/actionsV1.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import type { WorkflowActionExecute, WorkflowActionExecuteArgs } from './types.js';
import type { WorkflowActionIdV1, WorkflowIngressContextV1 } from '../../workflows/index.js';
import type { WorkflowTriggerActions } from './workflowTriggerActions.js';
import { WorkflowActionFailureV1Schema, type WorkflowActionFailureV1 } from '../../workflows/workflowProgressV1.js';

/** One closed failure projection for both the family and host preparation. */
export function normalizeWorkflowActionThrownError(error: unknown): WorkflowActionFailureV1 {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'content_unavailable';
  const failure = WorkflowActionFailureV1Schema.safeParse({
    ok: false,
    errorCode: code,
    error: error instanceof Error ? error.message : code,
    ...(error !== null && typeof error === 'object' && 'details' in error ? { details: error.details } : {}),
  });
  return failure.success ? failure.data : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
}

/** Request validation is not a failure to read private persisted content. */
function parseWorkflowActionInput<T>(schema: Readonly<{ parse: (input: unknown) => T }>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch {
    throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
  }
}

type DefinitionActions = Readonly<{
  list: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.list']['parse']>) => Promise<WorkflowActionResult>;
  get: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.get']['parse']>) => Promise<WorkflowActionResult>;
  create: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.create']['parse']>, context?: WorkflowIngressContextV1,
    caller?: WorkflowActionExecuteArgs['context']) => Promise<WorkflowActionResult>;
  update: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.update']['parse']>, context?: WorkflowIngressContextV1,
    caller?: WorkflowActionExecuteArgs['context']) => Promise<WorkflowActionResult>;
  edit: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.edit']['parse']>, context?: WorkflowIngressContextV1,
    caller?: WorkflowActionExecuteArgs['context']) => Promise<WorkflowActionResult>;
  delete: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.delete']['parse']>) => Promise<WorkflowActionResult>;
}>;

type RunActionId = Extract<WorkflowActionIdV1, `workflow.run.${string}`>;
type RunActionArgs = { [TActionId in RunActionId]: WorkflowActionExecuteArgs<TActionId> }[RunActionId];
type WorkflowActionResult = Awaited<ReturnType<WorkflowActionExecute>>;

function isWorkflowRunActionArgs(args: WorkflowActionExecuteArgs): args is RunActionArgs {
  return args.actionId.startsWith('workflow.run.');
}

export type WorkflowRunActionOwner = Readonly<{
  execute: (args: RunActionArgs, context?: WorkflowIngressContextV1) => Promise<WorkflowActionResult>;
}>;

type WorkflowTargetValidation = Readonly<{
  targetValidation: 'checked' | 'unavailable';
  targetIssues?: ReadonlyArray<Readonly<{
    code: 'target_unavailable'; path: string; message: string; severity: 'error' | 'warning';
  }>>;
}>;

/**
 * The shared workflow-family adapter for the canonical Action
 * executor. Run semantics remain in the injected origin-neutral Run owner;
 * definition persistence remains in the Account Artifact owner.
 */
export function createWorkflowActionExecutor(deps: Readonly<{
  isWorkflowFeatureEnabled: () => Promise<boolean> | boolean;
  definitions: DefinitionActions;
  triggers?: WorkflowTriggerActions;
  runs: WorkflowRunActionOwner;
  resolveIngressContext?: (args: WorkflowActionExecuteArgs) => Promise<WorkflowIngressContextV1 | undefined>;
  resolveTargetValidation?: (args: WorkflowActionExecuteArgs<'workflow.validate'>) => Promise<WorkflowTargetValidation>;
}>): WorkflowActionExecute {
  const execute: WorkflowActionExecute = async (rawArgs) => {
    let featureEnabled = false;
    try {
      featureEnabled = await deps.isWorkflowFeatureEnabled();
    } catch {
      featureEnabled = false;
    }
    if (!featureEnabled) {
      return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }

    const actionId = rawArgs.actionId;
    if (actionId === 'workflow.run.wait'
      && (rawArgs.context.surface === 'agent' || rawArgs.context.surface === 'mcp')
      && rawArgs.context.defaultSessionId
      && rawArgs.input.timeoutSeconds === undefined) {
      return { ok: false, errorCode: 'invalid_input', error: 'invalid_input' };
    }
    const resolvesIngress = actionId === 'workflow.validate'
      || actionId === 'workflow.run.start'
      || actionId === 'workflow.run.resume'
      || actionId === 'workflow.run.invocations.retry'
      || actionId === 'workflow.run.invocations.complete_review'
      || actionId === 'workflow.definition.create'
      || actionId === 'workflow.definition.update'
      || actionId === 'workflow.definition.edit';
    const context = resolvesIngress
      ? await deps.resolveIngressContext?.(rawArgs)
      : undefined;
    if (actionId === 'workflow.validate') {
      const input = parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input);
      const target = input.target
        ? await deps.resolveTargetValidation?.({ ...rawArgs, actionId, input })
          ?? { targetValidation: 'unavailable' as const }
        : { targetValidation: 'not_requested' as const };
      return WorkflowActionOutputSchemasV1[actionId].parse(validateWorkflowDefinition(input.definition, {
        ...(context ? { context } : {}),
        ...target,
      }));
    }
    if (actionId === 'workflow.definition.list') {
      return await deps.definitions.list(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input));
    }
    if (actionId === 'workflow.definition.get') {
      return await deps.definitions.get(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input));
    }
    if (actionId === 'workflow.definition.create') {
      return await deps.definitions.create(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context, rawArgs.context);
    }
    if (actionId === 'workflow.definition.update') {
      return await deps.definitions.update(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context, rawArgs.context);
    }
    if (actionId === 'workflow.definition.edit') {
      return await deps.definitions.edit(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context, rawArgs.context);
    }
    if (actionId === 'workflow.definition.delete') {
      return await deps.definitions.delete(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input));
    }
    if (actionId === 'workflow.trigger.list') {
      return deps.triggers ? deps.triggers.list(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input))
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'workflow.trigger.add') {
      return deps.triggers ? deps.triggers.add(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'workflow.trigger.update') {
      return deps.triggers ? deps.triggers.update(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'workflow.trigger.remove') {
      return deps.triggers ? deps.triggers.remove(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input))
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'session.trigger.list') {
      return deps.triggers ? deps.triggers.sessionList(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'session.trigger.add') {
      return deps.triggers ? deps.triggers.sessionAdd(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'session.trigger.update') {
      return deps.triggers ? deps.triggers.sessionUpdate(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (actionId === 'session.trigger.remove') {
      return deps.triggers ? deps.triggers.sessionRemove(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
        : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    if (!isWorkflowRunActionArgs(rawArgs)) {
      return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
    }
    switch (rawArgs.actionId) {
      case 'workflow.run.start':
      case 'workflow.run.list':
      case 'workflow.run.summaries':
      case 'workflow.run.get':
      case 'workflow.run.wait':
      case 'workflow.run.pause':
      case 'workflow.run.resume':
      case 'workflow.run.cancel':
      case 'workflow.run.invocations.list':
      case 'workflow.run.invocations.get':
      case 'workflow.run.invocations.retry':
      case 'workflow.run.invocations.publish_draft':
      case 'workflow.run.invocations.complete_review':
      case 'workflow.run.delete':
        parseWorkflowActionInput<unknown>(WorkflowActionInputSchemasV1[rawArgs.actionId], rawArgs.input);
        return await deps.runs.execute(rawArgs, context);
      default:
        rawArgs satisfies never;
        throw new Error('unreachable_workflow_run_action');
    }
  };
  return async (args) => {
    try {
      return await execute(args);
    } catch (error) {
      return normalizeWorkflowActionThrownError(error);
    }
  };
}
