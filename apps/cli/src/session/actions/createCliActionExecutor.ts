import { createActionExecutor } from '@happier-dev/protocol';

import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { createCliActionDeps } from './createCliActionDeps';

export function createCliActionExecutor(
  params: Parameters<typeof createCliActionDeps>[0],
): ReturnType<typeof createActionExecutor> {
  return createActionExecutor({
    ...createCliActionDeps(params),
    isActionEnabled: (id, ctx) => isActionEnabledByEnv(id, {
      surface: ctx.surface ?? 'cli',
      placement: ctx.placement ?? null,
    }),
  });
}
