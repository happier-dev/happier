import { WORKFLOW_SUBJECTS_LIST_ACTION_ID_V1 } from '../actionIds.js';
import { WorkflowActionInputSchemasV1, WorkflowActionOutputSchemasV1, WorkflowRunWaitSnapshotV1Schema } from '../../workflows/actionsV1.js';
import { validateWorkflowDefinition } from '../../workflows/workflowValidationV1.js';
import type { ActionExecutorDeps, HostReviewedChildrenPreparationV1, WorkflowActionExecute, WorkflowActionExecuteArgs } from './types.js';
import type { WorkflowActionIdV1, WorkflowIngressContextV1 } from '../../workflows/index.js';
import type { WorkflowTriggerActions } from './workflowTriggerActions.js';
import { WorkflowActionFailureV1Schema, type WorkflowActionFailureV1 } from '../../workflows/workflowProgressV1.js';
import { getActionSpec } from '../actionSpecs.js';
import { WORKFLOW_ACTIVITY_LIST_ACTION_ID_V1 } from '../actionIds.js';
import { projectConfirmedActionHttpRefusal, readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { resolveWorkflowActionContext } from './callerContext.js';
import { readActionFailureCauseV1, projectActionFailureCauseV1 } from '../actionExecutionResult.js';
import { z } from '../../zodRuntimePolicy.js';
import { projectActionInputIssues } from './actionInputValidation.js';
import type { ActionAutomationWaitV1, ActionAutomationCancelV1 } from './actionAutomationAdmission.js';

export type WorkflowActionFailureDiagnosticV1 = Readonly<{
  event: 'workflow_action_failure';
  errorCode: 'storage_unavailable' | 'content_unavailable' | 'run_access_denied';
  originalCode: string | null;
  httpStatus: number | null;
  operation: string;
  durationMs: number;
}>;

/** One closed failure projection for both the family and host preparation. */
export function normalizeWorkflowActionThrownError(error: unknown, diagnostic?: Readonly<{
  operation: string;
  durationMs: number;
  emit: (diagnostic: WorkflowActionFailureDiagnosticV1) => void;
}>, preEffect = false, phase = diagnostic?.operation ?? 'dispatch'): WorkflowActionFailureV1 {
  if (phase === 'workflow.run.start' && error instanceof z.core.$ZodError) {
    return { ok: false, errorCode: 'invalid_input', error: 'invalid_input', details: {
      issues: projectActionInputIssues(error).map(issue => ({
        code: 'invalid_input', severity: 'error',
        path: issue.path.map(segment => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join(''),
        message: issue.message ?? 'Invalid input',
      })),
    } };
  }
  const thrown = error !== null && typeof error === 'object' ? error : null;
  // The exact-Home Session reader uses errorCode, not code. Only its semantic
  // not_found/forbidden refusals prove an unavailable execution target;
  // transport, server and unreadable-response failures remain retryable storage failures.
  // Recognize that boundary's shape without importing a UI-owned Error class.
  const sessionSnapshotCode = thrown !== null && 'name' in thrown && thrown.name === 'SessionSnapshotReadError'
    && 'errorCode' in thrown && typeof thrown.errorCode === 'string' ? thrown.errorCode : undefined;
  const sessionSnapshotUnavailable = sessionSnapshotCode === 'not_found' || sessionSnapshotCode === 'forbidden';
  const thrownCode = sessionSnapshotUnavailable ? 'target_unavailable'
    // The reader wraps terminal Account auth separately from scoped Session denial.
    : sessionSnapshotCode === 'unauthorized' ? 'not_authenticated'
    : thrown && 'code' in thrown && typeof thrown.code === 'string' ? thrown.code
    : thrown && 'errorCode' in thrown && typeof thrown.errorCode === 'string' ? thrown.errorCode
    : 'storage_unavailable';
  // An aborted observer cannot prove that an issued write did not commit.
  // Native cancellation is conclusive only during preparation or a read.
  const rawCode = preEffect && (thrownCode === 'ERR_CANCELED'
    || (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError'))
    ? 'cancelled' : thrownCode;
  // The template codec's reasons also drive locked-row listing inside the
  // trigger owner. At the Action boundary they describe unreadable content,
  // not a failure to reach storage.
  const code = rawCode === 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE' ? 'target_unavailable'
    : rawCode === 'automation_disabled' ? 'ineligible_state'
    : rawCode === 'automation_not_found' || rawCode === 'artifact_not_found' || rawCode === 'not_found'
      || rawCode === 'automation_stored_content_unavailable' ? 'content_unavailable'
    : rawCode === 'artifact_access_forbidden' || rawCode === 'credential_scope_denied'
      || rawCode === 'discussion_read_denied' ? 'run_access_denied'
    : rawCode === 'version_mismatch' || rawCode === 'automation_template_version_conflict'
      || rawCode === 'automation_trigger_revision_conflict' || rawCode === 'event_contribution_not_current' ? 'currentness_conflict'
    // This is Account-wide preparation, before any role is selected. Keep
    // its specific read failure in content details rather than refusing a role.
    : rawCode === 'account_role_overrides_unavailable' ? 'content_unavailable'
    : rawCode === 'session_key_required' || rawCode === 'encryption_material_unavailable'
    || rawCode === 'encryption_mode_mismatch' || rawCode === 'invalid_template' || rawCode === 'invalid_action_output'
    ? 'content_unavailable' : rawCode;
  const details = rawCode === 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE'
    ? { code: 'target_unavailable', reason: 'requester_runtime_unavailable', errorCode: rawCode }
    : sessionSnapshotUnavailable ? { code: 'target_unavailable', reason: 'session_unavailable' }
    : rawCode === 'account_role_overrides_unavailable' ? { reason: rawCode }
    : rawCode === 'event_contribution_not_current' ? { reason: rawCode }
    : error !== null && typeof error === 'object' && 'details' in error ? error.details : undefined;
  const sourceCause = thrown && 'failureCause' in thrown && thrown.failureCause !== undefined
    ? readActionFailureCauseV1(thrown.failureCause) : undefined;
  const projectedCause = sourceCause ?? projectActionFailureCauseV1(error, phase);
  const failureCause = sourceCause !== undefined || projectedCause.errorCode !== null || projectedCause.httpStatus !== null
    ? projectedCause : undefined;
  const causeFields = failureCause === undefined ? {} : { failureCause };
  const failure = WorkflowActionFailureV1Schema.safeParse({
    ok: false,
    errorCode: code,
    error: error instanceof Error ? error.message : code,
    ...causeFields,
    ...(details !== undefined ? { details } : code === 'target_unavailable'
      ? { details: { code: 'target_unavailable', reason: 'selection_unavailable' } } : {}),
  });
  const result: WorkflowActionFailureV1 = failure.success ? failure.data
    : { ok: false, errorCode: 'storage_unavailable', error: 'storage_unavailable', ...causeFields };
  if ((result.errorCode === 'storage_unavailable' || result.errorCode === 'run_access_denied'
    || (rawCode === 'account_role_overrides_unavailable' && result.errorCode === 'content_unavailable')) && diagnostic) {
    let originalCode: string | null = null;
    let httpStatus: number | null = null;
    let operation = diagnostic.operation;
    let durationMs = diagnostic.durationMs;
    const seen = new Set<object>();
    for (let cause = error; cause && typeof cause === 'object' && !seen.has(cause);) {
      seen.add(cause);
      if ('code' in cause && typeof cause.code === 'string' && /^[A-Za-z0-9_.:-]+$/.test(cause.code)) originalCode = cause.code;
      if ('response' in cause && cause.response && typeof cause.response === 'object'
        && 'status' in cause.response && typeof cause.response.status === 'number'
        && Number.isInteger(cause.response.status) && cause.response.status >= 100 && cause.response.status <= 599) {
        httpStatus = cause.response.status;
      }
      if ('workflowStorageOperation' in cause && cause.workflowStorageOperation && typeof cause.workflowStorageOperation === 'object') {
        const storage = cause.workflowStorageOperation;
        if ('operation' in storage && typeof storage.operation === 'string' && /^[a-z._-]+$/.test(storage.operation)
          && 'durationMs' in storage && typeof storage.durationMs === 'number' && Number.isFinite(storage.durationMs) && storage.durationMs >= 0) {
          operation = storage.operation;
          durationMs = storage.durationMs;
        }
      }
      cause = 'cause' in cause ? cause.cause : undefined;
    }
    diagnostic.emit({ event: 'workflow_action_failure', errorCode: result.errorCode, originalCode,
      httpStatus, operation, durationMs });
  }
  return result.errorCode === 'workflow_http_error'
    ? projectConfirmedActionHttpRefusal(result, result.details.status) : result;
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
  delete: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.delete']['parse']>,
    caller?: WorkflowActionExecuteArgs['context']) => Promise<WorkflowActionResult>;
  importDocument: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.import']['parse']>, context?: WorkflowIngressContextV1) => Promise<WorkflowActionResult>;
  exportDocument: (input: ReturnType<typeof WorkflowActionInputSchemasV1['workflow.definition.export']['parse']>, context?: WorkflowIngressContextV1) => Promise<WorkflowActionResult>;
}>;

type RunActionId = Extract<WorkflowActionIdV1, `workflow.run.${string}`>;
type RunActionArgs = { [TActionId in RunActionId]: WorkflowActionExecuteArgs<TActionId> }[RunActionId];
type WorkflowActionResult = Awaited<ReturnType<WorkflowActionExecute>>;

function isWorkflowRunActionArgs(args: WorkflowActionExecuteArgs): args is RunActionArgs {
  return args.actionId.startsWith('workflow.run.');
}

export type WorkflowStartApprovalPreparationV1 = (args: WorkflowActionExecuteArgs<'workflow.run.start'>,
  presentationDeps: Pick<ActionExecutorDeps, 'homeDomainAction'>, context?: WorkflowIngressContextV1) => Promise<HostReviewedChildrenPreparationV1>;

export type WorkflowRunActionOwner = Readonly<{
  prepareStartApproval?: WorkflowStartApprovalPreparationV1;
  waitAutomaticCheck?: ActionAutomationWaitV1;
  cancelAutomaticCheck?: ActionAutomationCancelV1;
  waitCombinedAction?: (args: WorkflowActionExecuteArgs<'workflow.run.wait'>, context?: WorkflowIngressContextV1) => Promise<ReturnType<typeof WorkflowRunWaitSnapshotV1Schema.parse>>;
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
  onFailureDiagnostic?: (diagnostic: WorkflowActionFailureDiagnosticV1) => void;
  isWorkflowFeatureEnabled: () => Promise<boolean> | boolean;
  definitions: DefinitionActions;
  triggers?: WorkflowTriggerActions;
  runs: WorkflowRunActionOwner;
  resolveIngressContext?: (args: WorkflowActionExecuteArgs) => Promise<WorkflowIngressContextV1 | undefined>;
  resolveTargetValidation?: (args: WorkflowActionExecuteArgs<'workflow.validate'>) => Promise<WorkflowTargetValidation>;
}>): WorkflowActionExecute & Readonly<{
  prepareTriggerMutation: NonNullable<WorkflowActionExecute['prepareTriggerMutation']>;
  waitAutomaticCheck?: ActionAutomationWaitV1;
  cancelAutomaticCheck?: ActionAutomationCancelV1;
  waitCombined: (args: WorkflowActionExecuteArgs<'workflow.run.wait'>) => Promise<ReturnType<typeof WorkflowRunWaitSnapshotV1Schema.parse> | WorkflowActionFailureV1>;
  prepareStartApproval: (args: WorkflowActionExecuteArgs<'workflow.run.start'>,
  presentationDeps: Pick<ActionExecutorDeps, 'homeDomainAction'>) => Promise<HostReviewedChildrenPreparationV1 | WorkflowActionFailureV1> }> {
  const resolvePreparation = async (rawArgs: WorkflowActionExecuteArgs) => {
      const resolved = resolveWorkflowActionContext(rawArgs.context);
      if (!resolved.ok) throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
      rawArgs = { ...rawArgs, context: resolved.context };
      // A failed observation reaches the shared failure classifier. It grants
      // no availability, but is distinct from a settled disabled decision.
      const featureEnabled = rawArgs.context.workflowTriggerMutationAdmission?.actionId === rawArgs.actionId
        || await deps.isWorkflowFeatureEnabled();
      if (!featureEnabled) {
        throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      }

      const actionId = rawArgs.actionId;
      const resolvesIngress = actionId === 'workflow.validate'
        || actionId === 'workflow.run.start'
        || actionId === 'workflow.run.resume'
        || actionId === 'workflow.run.invocations.retry'
        || actionId === 'workflow.run.invocations.complete_review'
        || actionId === 'workflow.definition.create'
        || actionId === 'workflow.definition.update'
        || actionId === 'workflow.definition.edit'
        || actionId === 'workflow.definition.import';
      const context = resolvesIngress
        ? await deps.resolveIngressContext?.(rawArgs)
        : undefined;
    return { args: rawArgs, context };
  };
  const execute: WorkflowActionExecute = async (rawArgs) => {
    const startedAtMs = Date.now();
    let preparing = true;
    try {
      const prepared = await resolvePreparation(rawArgs);
      rawArgs = prepared.args;
      const context = prepared.context;
      const actionId = rawArgs.actionId;
      preparing = false;
      if (rawArgs.actionId === 'workflow.definition.capture') {
        if (!rawArgs.captureDefinition) return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
        const captured = await rawArgs.captureDefinition(rawArgs.context);
        const failure = readActionFailureEnvelope(captured);
        if (failure) return normalizeWorkflowActionThrownError(failure, undefined, true);
        return WorkflowActionOutputSchemasV1[rawArgs.actionId].parse(captured);
      }
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
      if (actionId === 'workflow.definition.import') {
        return await deps.definitions.importDocument(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context);
      }
      if (actionId === 'workflow.definition.export') {
        return await deps.definitions.exportDocument(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), context);
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
        return await deps.definitions.delete(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context);
      }
      if (actionId === WORKFLOW_SUBJECTS_LIST_ACTION_ID_V1) {
        return deps.triggers ? await deps.triggers.listSubjects(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input))
          : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      }
      if (actionId === 'workflow.trigger.list') {
        return deps.triggers ? await deps.triggers.list(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
          : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      }
      if (actionId === 'workflow.trigger.run_now') {
        return deps.triggers ? await deps.triggers.runNow(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
          : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      }
      if (actionId === 'workflow.trigger.add') {
        return deps.triggers ? await deps.triggers.add(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
          : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      }
      if (actionId === 'workflow.trigger.update') {
        return deps.triggers ? await deps.triggers.update(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
          : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      }
      if (actionId === 'workflow.trigger.remove') {
        return deps.triggers ? await deps.triggers.remove(parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input), rawArgs.context)
          : { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      }
      if (actionId === WORKFLOW_ACTIVITY_LIST_ACTION_ID_V1) {
        const input = parseWorkflowActionInput(WorkflowActionInputSchemasV1[actionId], rawArgs.input);
        const retained = await deps.runs.execute({ actionId: 'workflow.run.list',
          input: { ...input, projection: 'membership' }, context: rawArgs.context,
          ...(rawArgs.signal ? { signal: rawArgs.signal } : {}),
        }, context);
        const failure = readActionFailureEnvelope(retained);
        return failure ?? { retained, live: { kind: 'unavailable', reason: 'ui_local_only' } };
      }
      if (!isWorkflowRunActionArgs(rawArgs)) {
        return { ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' };
      }
      switch (rawArgs.actionId) {
        case 'workflow.run.start':
        case 'workflow.run.list':
        case 'workflow.run.summaries':
        case 'workflow.run.get':
        case 'workflow.run.read_state.set':
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
          // The indexed schema matches this discriminant; preserve that correlation after parsing.
          return await deps.runs.execute({ ...rawArgs,
            input: parseWorkflowActionInput<RunActionArgs['input']>(WorkflowActionInputSchemasV1[rawArgs.actionId], rawArgs.input),
          } as RunActionArgs, context);
        default:
          rawArgs satisfies never;
          throw new Error('unreachable_workflow_run_action');
      }
    } catch (error) {
      return normalizeWorkflowActionThrownError(error, deps.onFailureDiagnostic ? {
        operation: rawArgs.actionId, durationMs: Date.now() - startedAtMs, emit: deps.onFailureDiagnostic,
      } : undefined, preparing || getActionSpec(rawArgs.actionId).sideEffectClass === 'read', rawArgs.actionId);
    }
  };
  return Object.assign(execute, {
    prepareTriggerMutation: async (args: WorkflowActionExecuteArgs<import('../workflowTriggerActionIds.js').WorkflowTriggerMutationActionId>) => {
      try {
        const prepared = await resolvePreparation(args);
        if (!deps.triggers) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
        return await deps.triggers.prepareMutation({ ...args, context: prepared.args.context });
      } catch (error) {
        return normalizeWorkflowActionThrownError(error, undefined, true, args.actionId);
      }
    },
    ...(deps.runs.waitAutomaticCheck ? { waitAutomaticCheck: deps.runs.waitAutomaticCheck } : {}),
    ...(deps.runs.cancelAutomaticCheck ? { cancelAutomaticCheck: deps.runs.cancelAutomaticCheck } : {}),
    waitCombined: async (args: WorkflowActionExecuteArgs<'workflow.run.wait'>) => {
    const startedAtMs = Date.now();
    try {
      const prepared = await resolvePreparation(args);
      if (!deps.runs.waitCombinedAction) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      return await deps.runs.waitCombinedAction({ ...args, context: prepared.args.context,
        input: parseWorkflowActionInput(WorkflowActionInputSchemasV1['workflow.run.wait'], args.input) }, prepared.context);
    } catch (error) {
      return normalizeWorkflowActionThrownError(error, deps.onFailureDiagnostic ? {
        operation: args.actionId, durationMs: Date.now() - startedAtMs, emit: deps.onFailureDiagnostic,
      } : undefined, true, args.actionId);
    }
  }, prepareStartApproval: async (args: WorkflowActionExecuteArgs<'workflow.run.start'>,
    presentationDeps: Pick<ActionExecutorDeps, 'homeDomainAction'>) => {
    const startedAtMs = Date.now();
    try {
      const prepared = await resolvePreparation(args);
      if (!deps.runs.prepareStartApproval) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      const result = await deps.runs.prepareStartApproval({ ...args, context: prepared.args.context }, presentationDeps, prepared.context);
      const executeAdmittedAction = result.executeAdmittedAction;
      return { ...result, ...(executeAdmittedAction ? { executeAdmittedAction: (async request => {
        const executionStartedAtMs = Date.now();
        try { return await executeAdmittedAction(request); }
        catch (error) {
          return normalizeWorkflowActionThrownError(error, deps.onFailureDiagnostic ? {
            operation: args.actionId, durationMs: Date.now() - executionStartedAtMs, emit: deps.onFailureDiagnostic,
          } : undefined, false, args.actionId);
        }
      }) satisfies HostReviewedChildrenPreparationV1['executeAdmittedAction'] } : {}) };
    } catch (error) {
      return normalizeWorkflowActionThrownError(error, deps.onFailureDiagnostic ? {
        operation: args.actionId, durationMs: Date.now() - startedAtMs, emit: deps.onFailureDiagnostic,
      } : undefined, true, args.actionId);
    }
  } });
}
