import { readActionsSettingsFromEnv } from '@/settings/actionsSettings';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

function resolveCallerPermissionMode(params: Parameters<typeof createCliActionExecutorHarness>[0]): string | null {
  const mode = params.getCallerPermissionMode?.();
  return typeof mode === 'string' && mode.trim().length > 0 ? mode.trim() : null;
}

export function createCliActionExecutor(
  params: Parameters<typeof createCliActionExecutorHarness>[0],
  overrides?: Partial<ActionExecutorDeps>,
): ReturnType<typeof createCliActionExecutorHarness>['executor'] {
  const base = createCliActionExecutorHarness(params, overrides).executor;

  const withCliContext = (
    context: Parameters<typeof base.execute>[2],
  ): NonNullable<Parameters<typeof base.execute>[2]> => {
    const callerPermissionMode = resolveCallerPermissionMode(params);
    return {
      ...(context ?? {}),
      surface: context?.surface ?? 'cli',
      ...(callerPermissionMode ? { callerPermissionMode } : {}),
      actionsSettings: readActionsSettingsFromEnv(),
    };
  };

  return {
    prepare: async (actionId, input, context) => await base.prepare(
      actionId,
      input,
      withCliContext(context),
    ),
    execute: async (actionId, input, context) => {
      return await base.execute(actionId, input, withCliContext(context));
    },
  };
}
