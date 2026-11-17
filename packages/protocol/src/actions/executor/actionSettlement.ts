import type { AutomationSubjectContextV1 } from '../../automations/automationSubjectV1.js';
import type { ActionExecuteResult, ActionExecutorContext } from './types.js';
import type { ActionAutomationPortV1, ActionAutomationSelectionV1 } from './actionAutomationAdmission.js';
import { isDeferredApprovalResult } from './resultProjection.js';
import type { AutomationActionOutcomeV1 } from '../../automations/automationActionIdentityV1.js';
import { withActionAutomationNoticesV1, type ActionAutomationNoticeV1 } from '../actionExecutionResult.js';
import { readActionWorkflowOriginRunIdV1 } from '../actionRequestAttributionV1.js';

/** Closed local evidence. The HTTP owner further projects subjects to structural digests. */
export type ActionSettlementV1 = Readonly<{
  v: 1;
  kind: 'action';
  actionId: string;
  requestId: string;
  phase: 'after';
  occurredAt: number;
  status: 'succeeded' | 'failed';
  outcome?: AutomationActionOutcomeV1;
  errorCode?: string;
  subjects: readonly AutomationSubjectContextV1[];
  originRunId?: string;
  machineId?: string;
}>;

/** Invocation-local one-shot settlement, retained with the existing prepared invocation. */
export type ActionAutomationInvocationV1 = Readonly<{
  actionId: string;
  selection: ActionAutomationSelectionV1;
  settle(result: ActionExecuteResult, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
}>;

/** Execution placement comes from the admitted host, never a subject's resource identity. */
export function readActionAutomationExecutionMachineV1(context: ActionExecutorContext): string | undefined {
  return context.admittedMachineTarget?.machineId
    ?? (context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : undefined)
    ?? context.agentStartContext?.baseline.machineId
    ?? context.defaultSessionMachineId ?? undefined;
}

export function createActionAutomationInvocationV1(args: Readonly<{
  actionId: string;
  context: ActionExecutorContext;
  selection: ActionAutomationSelectionV1;
  port: ActionAutomationPortV1;
  notices?: readonly ActionAutomationNoticeV1[];
}>): ActionAutomationInvocationV1 {
  let publication: Promise<readonly ActionAutomationNoticeV1[] | void> | undefined;
  return Object.freeze({ actionId: args.actionId, selection: args.selection,
    async settle(result: ActionExecuteResult, context = args.context) {
      const annotated = withActionAutomationNoticesV1(result,
        [...(args.selection.notices ?? []), ...(args.notices ?? [])]);
      if (isDeferredApprovalResult(result) || args.selection.after.length === 0) return annotated;
      publication ??= (async () => {
        const requestId = context.actionRequestId;
        if (!requestId) return;
        const originRunId = readActionWorkflowOriginRunIdV1(context);
        const machineId = readActionAutomationExecutionMachineV1(context);
        const event: ActionSettlementV1 = {
          v: 1, kind: 'action', actionId: args.actionId, requestId, phase: 'after', occurredAt: Date.now(),
          status: result.ok ? 'succeeded' : 'failed', outcome: result.ok ? 'succeeded' : 'failed', ...(!result.ok ? { errorCode: result.errorCode } : {}),
          subjects: args.selection.subjects,
          ...(originRunId ? { originRunId } : {}),
          ...(machineId ? { machineId } : {}),
        };
        try { return await args.port.settle({ selection: args.selection, event, context }); }
        catch { /* The effect and its authoritative result survive an observation failure. */ }
      })();
      return withActionAutomationNoticesV1(annotated, await publication);
    },
  });
}
