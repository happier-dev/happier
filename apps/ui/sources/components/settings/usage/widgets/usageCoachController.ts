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
import { WorkflowTriggerWriteResultV1Schema, type WorkflowTriggerAddRequestV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

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
  /** Dismissed/snoozed and acknowledged by the preference owner in this mount, before the Resource re-reads. */
  hiddenEvidenceKeys: readonly string[];
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
  dismiss(query: UsageQuery, evidenceKey: string): Promise<ActionExecuteResult>;
  snooze(
    query: UsageQuery,
    evidenceKey: string,
    untilMs: number | null,
  ): Promise<ActionExecuteResult>;
  createDigest(suggestion: UsageCoachDigestSuggestion, project: WorkflowProjectTargetV1,
    trigger: AutomationScheduleTriggerInput): Promise<ActionExecuteResult>;
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
  hiddenEvidenceKeys: [],
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
  ): Promise<ActionExecuteResult> {
    if (!current()) return failure('action_account_scope_changed');
    if (
      snapshot.pending.some((row) => row.evidenceKey === operation.evidenceKey)
    )
      return failure('usage_coach_operation_pending');
    const controller = new AbortController();
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
        error: {
          evidenceKey: operation.evidenceKey,
          actionId: operation.actionId,
          failure: result,
        },
      });
      return result;
    };
    try {
      const result = await execute(operation.actionId, input, {
        surface: 'ui',
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
        return result;
      }
      const next = settle(result.result);
      if (!next) return fail(failure('usage_coach_result_invalid'));
      publish(next);
      options.onSettled?.();
      return result;
    } catch {
      if (!current()) return failure('action_account_scope_changed');
      return fail(
        failure(
          controller.signal.aborted
            ? 'cancelled'
            : 'usage_coach_outcome_unknown',
        ),
      );
    } finally {
      if (operations.delete(controller) && !snapshot.retired)
        publish({ ...snapshot, pending: [...operations.values()] });
    }
  }

  const hide = (evidenceKey: string) =>
    snapshot.hiddenEvidenceKeys.includes(evidenceKey)
      ? snapshot.hiddenEvidenceKeys
      : [...snapshot.hiddenEvidenceKeys, evidenceKey];
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
    dismiss: (query, evidenceKey) =>
      run(
        { actionId: 'usage.coach.dismiss', evidenceKey },
        { query, evidenceKey, dismissed: true },
        (value) =>
          UsageCoachPreferenceResultSchema.safeParse(value).success
            ? { ...snapshot, hiddenEvidenceKeys: hide(evidenceKey) }
            : null,
      ),
    snooze: (query, evidenceKey, untilMs) =>
      run(
        { actionId: 'usage.coach.snooze', evidenceKey },
        { query, evidenceKey, untilMs },
        (value) =>
          UsageCoachPreferenceResultSchema.safeParse(value).success
            ? {
                ...snapshot,
                hiddenEvidenceKeys:
                  untilMs === null
                    ? snapshot.hiddenEvidenceKeys.filter(
                        (key) => key !== evidenceKey,
                      )
                    : hide(evidenceKey),
              }
            : null,
      ),
    createDigest: (suggestion, project, trigger) =>
      run(
        { actionId: 'workflow.trigger.add', evidenceKey: suggestion.queryKey },
        { target: suggestion.target, project, trigger } satisfies WorkflowTriggerAddRequestV1,
        (value) => {
          const parsed = WorkflowTriggerWriteResultV1Schema.safeParse(value);
          return parsed.success ? { ...snapshot, digest: { queryKey: suggestion.queryKey, result: parsed.data } } : null;
        },
      ),
    dispose,
  };
}
