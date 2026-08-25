import {
  createActionExecutor,
  isActionEnabledByActionsSettings,
  isApprovalRequiredByActionsSettings,
  createUnavailableRuntimeActionExecutor,
  type ActionExecutorDeps,
} from '@happier-dev/protocol';

import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';

import { createCliActionDeps } from './createCliActionDeps';
import { createActionExecutionHookDeps } from './createActionExecutionHookDeps';
import { getSharedBlockingApprovalCoordinator } from './approvals/blockingApprovalCoordinator';

function normalizePollIntervalMs(raw: unknown): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.max(1, Math.min(60_000, Math.floor(parsed)));
}

type MutableActionExecutorDeps = {
  -readonly [Key in keyof ActionExecutorDeps]: ActionExecutorDeps[Key];
};

type ApprovalWaitForDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>[0];
type ApprovalResolveBlockingDecisionArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsResolveBlockingDecision']>>[0];
type ApprovalUpdateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsUpdate']>>[0];
type ApprovalCreateArgs = Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0];

export function createCliActionExecutorHarness(
  params: Parameters<typeof createCliActionDeps>[0],
  overrides?: Partial<ActionExecutorDeps>,
): Readonly<{
  deps: ActionExecutorDeps;
  executor: ReturnType<typeof createActionExecutor>;
}> {
  const coordinator = getSharedBlockingApprovalCoordinator();
  const baseDeps = createCliActionDeps(params);
  const actionSettingsProvider = createActionSettingsProvider();
  const isActionEnabled: NonNullable<ActionExecutorDeps['isActionEnabled']> = (id, ctx) =>
    isActionEnabledByActionsSettings(
      id,
      ctx.actionsSettings ?? actionSettingsProvider.getActionsSettings(),
      {
        surface: ctx.surface ?? 'cli',
        placement: ctx.placement ?? null,
      },
    );
  const isActionApprovalRequired: NonNullable<ActionExecutorDeps['isActionApprovalRequired']> = (id, ctx) =>
    isApprovalRequiredByActionsSettings(
      id,
      ctx.actionsSettings ?? actionSettingsProvider.getActionsSettings(),
      { surface: ctx.surface ?? null },
    );
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
    isActionEnabled,
    isActionApprovalRequired,
    runtimeActionExecute: createUnavailableRuntimeActionExecutor(),
    ...createActionExecutionHookDeps(),
    ...(overrides ?? {}),
  };
  const originalApprovalsUpdate = rawDeps.approvalsUpdate;
  const originalApprovalsCreate = rawDeps.approvalsCreate;
  if (originalApprovalsCreate) {
    rawDeps.approvalsCreate = async (args: ApprovalCreateArgs) => {
      const result = await originalApprovalsCreate(args);
      const artifactId = typeof (result as { artifactId?: unknown }).artifactId === 'string'
        ? (result as { artifactId: string }).artifactId
        : null;
      if (artifactId) coordinator.notifyApprovalUpdated({ artifactId, request: args.request });
      return result;
    };
  }
  if (originalApprovalsUpdate) {
    rawDeps.approvalsUpdate = async (args: ApprovalUpdateArgs) => {
      const result = await originalApprovalsUpdate(args);
      if ((result as { ok?: false })?.ok !== false) {
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
