import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';

import { isActionApprovalRequiredByEnv, isActionEnabledByEnv } from '@/settings/actionsSettings';

import { createBlockingApprovalCoordinator, getSharedBlockingApprovalCoordinator } from './approvals/blockingApprovalCoordinator';
import { createCliActionDeps } from './createCliActionDeps';

type CliActionExecutorDeps = ActionExecutorDeps & Readonly<{
  approvalsWaitForDecision?: ReturnType<typeof createBlockingApprovalCoordinator>['waitForDecision'];
  approvalsResolveBlockingDecision?: ReturnType<typeof createBlockingApprovalCoordinator>['resolveBlockingDecision'];
}>;

function resolveBlockingApprovalPollIntervalMs(): number {
  const raw = String(process.env.HAPPIER_BLOCKING_APPROVAL_POLL_INTERVAL_MS ?? '').trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(60_000, parsed) : 250;
}

function shouldNotifyApprovalUpdated(status: unknown): boolean {
  return status === 'rejected'
    || status === 'canceled'
    || status === 'executed'
    || status === 'failed';
}

export function createCliActionExecutorHarness(
  params: Parameters<typeof createCliActionDeps>[0],
  overrides?: Partial<ActionExecutorDeps>,
): Readonly<{
  deps: CliActionExecutorDeps;
  executor: ReturnType<typeof createActionExecutor>;
}> {
  const approvalCoordinator = getSharedBlockingApprovalCoordinator();
  const baseDeps = createCliActionDeps(params);
  const providedApprovalsUpdate = overrides?.approvalsUpdate ?? baseDeps.approvalsUpdate;
  const providedApprovalsGet = overrides?.approvalsGet ?? baseDeps.approvalsGet;
  const approvalsUpdate: ActionExecutorDeps['approvalsUpdate'] | undefined = providedApprovalsUpdate
    ? async (args) => {
        const updated = await providedApprovalsUpdate(args);
        const status = args.request.status;
        if ((updated as { ok?: unknown }).ok === true && shouldNotifyApprovalUpdated(status)) {
          approvalCoordinator.notifyApprovalUpdated({
            artifactId: args.artifactId,
            request: args.request,
          });
        }
        return updated;
      }
    : undefined;
  const approvalsWaitForDecision: NonNullable<ActionExecutorDeps['approvalsWaitForDecision']> = async (args) =>
    await approvalCoordinator.waitForDecision({
      ...args,
      readRequest: providedApprovalsGet
        ? async () => await providedApprovalsGet({
            artifactId: args.artifactId,
            serverId: args.serverId ?? null,
          })
        : null,
      pollIntervalMs: resolveBlockingApprovalPollIntervalMs(),
    });

  const deps: CliActionExecutorDeps = {
    ...baseDeps,
    isActionEnabled: (id, ctx) => isActionEnabledByEnv(id, {
      surface: ctx.surface ?? 'cli',
      placement: ctx.placement ?? null,
    }),
    isActionApprovalRequired: (id, ctx, defaultRequired) => isActionApprovalRequiredByEnv(id, {
      surface: ctx.surface ?? null,
    }, defaultRequired),
    ...(overrides ?? {}),
    ...(approvalsUpdate ? { approvalsUpdate } : {}),
    approvalsWaitForDecision,
    approvalsResolveBlockingDecision: approvalCoordinator.resolveBlockingDecision,
  };

  return {
    deps,
    executor: createActionExecutor(deps),
  };
}
