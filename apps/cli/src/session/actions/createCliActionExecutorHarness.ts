import {
  createActionExecutor,
  createUnavailableRuntimeActionExecutor,
  type ActionExecutorDeps,
  type ApprovalRequestV1,
} from '@happier-dev/protocol';

import { isActionApprovalRequiredByEnv, isActionEnabledByEnv } from '@/settings/actionsSettings';

import { createCliActionDeps } from './createCliActionDeps';
import { getSharedBlockingApprovalCoordinator } from './approvals/blockingApprovalCoordinator';

function normalizePollIntervalMs(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.max(1, Math.min(60_000, Math.floor(parsed)));
}

function shouldNotifyApprovalUpdated(request: ApprovalRequestV1): boolean {
  return request.status === 'rejected'
    || request.status === 'canceled'
    || request.status === 'executed'
    || request.status === 'failed';
}

type MutableActionExecutorDeps = {
  -readonly [Key in keyof ActionExecutorDeps]: ActionExecutorDeps[Key];
};

type ApprovalWaitForDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>[0];
type ApprovalResolveBlockingDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsResolveBlockingDecision']>>[0];
type ApprovalUpdateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsUpdate']>>[0];

export function createCliActionExecutorHarness(
  params: Parameters<typeof createCliActionDeps>[0],
  overrides?: Partial<ActionExecutorDeps>,
): Readonly<{
  deps: ActionExecutorDeps;
  executor: ReturnType<typeof createActionExecutor>;
}> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  const baseDeps = createCliActionDeps(params);
  const envIsActionEnabled: NonNullable<ActionExecutorDeps['isActionEnabled']> = (id, ctx) => isActionEnabledByEnv(id, {
    surface: ctx.surface ?? 'cli',
    placement: ctx.placement ?? null,
  });
  const envIsActionApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx) => isActionApprovalRequiredByEnv(id, {
    surface: ctx.surface ?? null,
  });
  const rawDeps: MutableActionExecutorDeps = {
    ...baseDeps,
    approvalsWaitForDecision: async (args: ApprovalWaitForDecisionArgs) => {
      const result = await coordinator.waitForDecision({
        artifactId: args.artifactId,
        request: args.request,
        serverId: args.serverId,
        signal: args.signal,
        pollIntervalMs: normalizePollIntervalMs(process.env.HAPPIER_BLOCKING_APPROVAL_POLL_INTERVAL_MS),
        readRequest: async () => {
          const getApproval = rawDeps.approvalsGet ?? baseDeps.approvalsGet;
          return getApproval ? await getApproval({ artifactId: args.artifactId, serverId: args.serverId ?? null }) : null;
        },
      });
      return { ...result, request: args.request };
    },
    approvalsResolveBlockingDecision: async (args: ApprovalResolveBlockingDecisionArgs) =>
      await coordinator.resolveBlockingDecision({
        artifactId: args.artifactId,
        request: args.request,
        decision: args.decision,
      }),
    isActionEnabled: envIsActionEnabled,
    isActionApprovalRequired: envIsActionApprovalRequired,
    runtimeActionExecute: createUnavailableRuntimeActionExecutor(),
    ...(overrides ?? {}),
  };
  const originalApprovalsUpdate = rawDeps.approvalsUpdate;
  if (originalApprovalsUpdate) {
    rawDeps.approvalsUpdate = async (args: ApprovalUpdateArgs) => {
      const result = await originalApprovalsUpdate(args);
      if ((result as { ok?: false })?.ok !== false && shouldNotifyApprovalUpdated(args.request)) {
        coordinator.notifyApprovalUpdated({
          artifactId: args.artifactId,
          request: args.request,
        });
      }
      return result;
    };
  }
  const deps = rawDeps as ActionExecutorDeps;

  return {
    deps,
    executor: createActionExecutor(deps),
  };
}
