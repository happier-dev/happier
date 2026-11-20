import {
  ActionApprovalRequestCreatedResultSchema,
  type ActionApprovalRequestCreatedResult,
  type ActionExecuteFailure,
  type ActionExecuteResult,
} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  UsageCoachApplyResultSchema,
  UsageCoachPreferenceResultSchema,
  UsageCoachUndoResultSchema,
} from '@happier-dev/protocol/usage/coach/coachActions';
import type { UsageCoachDigestSuggestion, UsageCoachFinding } from '@happier-dev/protocol/usage/coach/coachFinding';
import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';
import type { AutomationScheduleTriggerInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { WorkflowTriggerWriteResultV1Schema, type WorkflowTriggerAddRequestV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createActionApprovalContinuation, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

type CoachActionId =
  | 'usage.coach.apply'
  | 'usage.coach.undo'
  | 'usage.coach.dismiss'
  | 'usage.coach.snooze'
  | 'workflow.trigger.add';
export type UsageCoachApplyResult = ReturnType<
  typeof UsageCoachApplyResultSchema.parse
>;
export type UsageCoachOperation = Readonly<{
  actionId: CoachActionId;
  evidenceKey: string;
}>;
/** The owner's receipt for one Apply, kept for this mount so Undo survives the finding disappearing. */
export type UsageCoachAppliedEntry = Readonly<{
  evidenceKey: string;
  query: UsageQuery;
  finding: UsageCoachFinding;
  result: UsageCoachApplyResult;
  undone: boolean;
}>;
export type UsageCoachSnapshot = Readonly<{
  pending: readonly UsageCoachOperation[];
  applied: readonly UsageCoachAppliedEntry[];
  digest: Readonly<{ queryKey: string; result: ReturnType<typeof WorkflowTriggerWriteResultV1Schema.parse> }> | null;
  error: Readonly<{
    evidenceKey: string;
    actionId: CoachActionId;
    failure: ActionExecuteFailure;
  }> | null;
  approval: Readonly<{
    evidenceKey: string;
    request: ActionApprovalRequestCreatedResult;
  }> | null;
  retired: boolean;
}>;
export type UsageCoachController = Readonly<{
  getSnapshot(): UsageCoachSnapshot;
  subscribe(listener: () => void): () => void;
  apply(
    query: UsageQuery,
    finding: UsageCoachFinding,
  ): Promise<ActionExecuteResult>;
  undo(evidenceKey: string): Promise<ActionExecuteResult>;
  dismiss(query: UsageQuery, evidenceKey: string, dismissed?: boolean): Promise<ActionExecuteResult>;
  snooze(
    query: UsageQuery,
    evidenceKey: string,
    untilMs: number | null,
  ): Promise<ActionExecuteResult>;
  createDigest(suggestion: UsageCoachDigestSuggestion, project: WorkflowProjectTargetV1,
    trigger: AutomationScheduleTriggerInput, callerContext?: ActionExecutorContext): Promise<ActionExecuteResult>;
  dispose(): void;
}>;

const failure = (errorCode: string): ActionExecuteFailure => ({
  ok: false,
  errorCode,
  error: errorCode,
});
const EMPTY: UsageCoachSnapshot = {
  pending: [],
  applied: [],
  digest: null,
  error: null,
  approval: null,
  retired: false,
};

/**
 * Mounted presentation state for the Coach body. Every effect is an ordinary Action through
 * the front door (its approval policy, Coach revalidation and the owners' admission and restore);
 * this keeps only what the person just did, under the captured Home/Account lifetime.
 */
export function createUsageCoachController(
  options: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    executor?: Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>;
    /** Ask the shared Resource to re-read after an acknowledged change; never a second fetch. */
    onSettled?: () => void;
    /** The shared mounted approval owner reconnects the durable Action result. */
    onApproval?: (registration: ActionApprovalRegistration) => void;
  }>,
): UsageCoachController {
  let snapshot: UsageCoachSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  const operations = new Map<AbortController, UsageCoachOperation>();
  const execute = createFrontDoorActionExecute(options.executor);
  const publish = (next: UsageCoachSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  let retirement: Readonly<{ dispose(): void }> | undefined;
  const dispose = () => {
    if (snapshot.retired) return;
    for (const controller of operations.keys()) controller.abort();
    operations.clear();
    retirement?.dispose();
    publish({ ...EMPTY, retired: true });
  };
  const current = () => {
    if (!options.lifetime.isCurrent()) dispose();
    return !snapshot.retired;
  };

  async function run(
    operation: UsageCoachOperation,
    input: unknown,
    settle: (value: unknown) => UsageCoachSnapshot | null,
    callerContext?: ActionExecutorContext,
  ): Promise<ActionExecuteResult> {
    if (!current()) return failure('action_account_scope_changed');
    if (
      snapshot.pending.some((row) => row.evidenceKey === operation.evidenceKey)
    )
      return failure('usage_coach_operation_pending');
    const controller = new AbortController();
    let deferred = false;
    operations.set(controller, operation);
    publish({
      ...snapshot,
      pending: [...operations.values()],
      error: null,
      approval:
        snapshot.approval?.evidenceKey === operation.evidenceKey
          ? null
          : snapshot.approval,
    });
    const fail = (result: ActionExecuteFailure) => {
      publish({
        ...snapshot,
        pending: [...operations.values()],
        approval: snapshot.approval?.evidenceKey === operation.evidenceKey ? null : snapshot.approval,
        error: {
          evidenceKey: operation.evidenceKey,
          actionId: operation.actionId,
          failure: result,
        },
      });
      return result;
    };
    const complete = (value: unknown) => {
      if (!current() || !operations.has(controller)) return false;
      const next = settle(value);
      operations.delete(controller);
      if (!next) {
        fail(failure('usage_coach_result_invalid'));
        return false;
      }
      publish({ ...next, pending: [...operations.values()],
        approval: next.approval?.evidenceKey === operation.evidenceKey ? null : next.approval });
      if (!UsageCoachPreferenceResultSchema.safeParse(value).success) options.onSettled?.();
      return true;
    };
    try {
      const result = await execute(operation.actionId, input, {
        ...(callerContext ?? { surface: 'ui' as const }),
        serverId: options.lifetime.scope.serverId,
        expectedAccountId: options.lifetime.scope.accountId,
        signal: controller.signal,
      });
      if (!current()) return failure('action_account_scope_changed');
      if (!operations.has(controller)) return failure('cancelled');
      if (!result.ok) return fail(result);
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(
        result.result,
      );
      if (approval.success) {
        publish({
          ...snapshot,
          approval: {
            evidenceKey: operation.evidenceKey,
            request: approval.data,
          },
        });
        if (options.onApproval) {
          deferred = true;
          options.onApproval(createActionApprovalContinuation({
            artifactId: approval.data.artifactId,
            actionId: operation.actionId,
            scope: options.lifetime.scope,
            expectedInput: input,
            signal: controller.signal,
            refreshAfterExecution: false,
            onSucceeded: (value: unknown) => { complete(value); },
            onFailed: (code, ownerFailure) => {
              if (!current() || !operations.delete(controller)) return;
              fail(ownerFailure ?? failure(code));
            },
          }));
        }
        return result;
      }
      if (!complete(result.result)) return failure('usage_coach_result_invalid');
      return result;
    } catch {
      deferred = false;
      if (!current()) return failure('action_account_scope_changed');
      return fail(
        failure(
          controller.signal.aborted
            ? 'cancelled'
            : 'usage_coach_outcome_unknown',
        ),
      );
    } finally {
      if (!deferred && operations.delete(controller) && !snapshot.retired)
        publish({ ...snapshot, pending: [...operations.values()] });
    }
  }

  retirement = options.lifetime.onRetire(dispose);
  if (!current()) retirement.dispose();
  return {
    getSnapshot: () => {
      current();
      return snapshot;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply: (query, finding) =>
      run(
        { actionId: 'usage.coach.apply', evidenceKey: finding.evidenceKey },
        { query, evidenceKey: finding.evidenceKey },
        (value) => {
          const parsed = UsageCoachApplyResultSchema.safeParse(value);
          if (
            !parsed.success ||
            parsed.data.evidenceKey !== finding.evidenceKey
          )
            return null;
          const entry: UsageCoachAppliedEntry = {
            evidenceKey: finding.evidenceKey,
            query,
            finding,
            result: parsed.data,
            undone: false,
          };
          return {
            ...snapshot,
            applied: [
              ...snapshot.applied.filter(
                (row) => row.evidenceKey !== finding.evidenceKey,
              ),
              entry,
            ],
          };
        },
      ),
    undo: (evidenceKey) => {
      const entry = snapshot.applied.find(
        (row) => row.evidenceKey === evidenceKey && !row.undone,
      );
      if (!entry?.result.reversal)
        return Promise.resolve(failure('usage_coach_undo_unavailable'));
      return run(
        { actionId: 'usage.coach.undo', evidenceKey },
        { query: entry.query, evidenceKey, reversal: entry.result.reversal },
        (value) => {
          const parsed = UsageCoachUndoResultSchema.safeParse(value);
          if (!parsed.success || parsed.data.evidenceKey !== evidenceKey)
            return null;
          return {
            ...snapshot,
            applied: snapshot.applied.map((row) =>
              row === entry ? { ...row, undone: true } : row,
            ),
          };
        },
      );
    },
    dismiss: (query, evidenceKey, dismissed = true) =>
      run(
        { actionId: 'usage.coach.dismiss', evidenceKey },
        { query, evidenceKey, dismissed },
        (value) =>
          UsageCoachPreferenceResultSchema.safeParse(value).success
            ? snapshot
            : null,
      ),
    snooze: (query, evidenceKey, untilMs) =>
      run(
        { actionId: 'usage.coach.snooze', evidenceKey },
        { query, evidenceKey, untilMs },
        (value) =>
          UsageCoachPreferenceResultSchema.safeParse(value).success
            ? snapshot
            : null,
      ),
    createDigest: (suggestion, project, trigger, callerContext) =>
      run(
        { actionId: 'workflow.trigger.add', evidenceKey: suggestion.queryKey },
        { target: suggestion.target, project, trigger } satisfies WorkflowTriggerAddRequestV1,
        (value) => {
          const parsed = WorkflowTriggerWriteResultV1Schema.safeParse(value);
          return parsed.success ? { ...snapshot, digest: { queryKey: suggestion.queryKey, result: parsed.data } } : null;
        },
        callerContext,
      ),
    dispose,
  };
}
