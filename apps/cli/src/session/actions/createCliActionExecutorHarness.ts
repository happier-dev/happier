import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';

import { isActionApprovalRequiredByEnv, isActionEnabledByEnv } from '@/settings/actionsSettings';

import { createCliActionDeps } from './createCliActionDeps';

export function createCliActionExecutorHarness(
  params: Parameters<typeof createCliActionDeps>[0],
  overrides?: Partial<ActionExecutorDeps>,
): Readonly<{
  deps: ActionExecutorDeps;
  executor: ReturnType<typeof createActionExecutor>;
}> {
  const deps: ActionExecutorDeps = {
    ...createCliActionDeps(params),
    isActionEnabled: (id, ctx) => isActionEnabledByEnv(id, {
      surface: ctx.surface ?? 'cli',
      placement: ctx.placement ?? null,
    }),
    isActionApprovalRequired: (id, ctx) => isActionApprovalRequiredByEnv(id, {
      surface: ctx.surface ?? null,
    }),
    ...(overrides ?? {}),
  };

  return {
    deps,
    executor: createActionExecutor(deps),
  };
}
