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
    actionId: Parameters<typeof base.execute>[0],
    context: Parameters<typeof base.execute>[2],
  ): NonNullable<Parameters<typeof base.execute>[2]> => {
    const callerPermissionMode = resolveCallerPermissionMode(params);
    return {
      ...(context ?? {}),
      surface: context?.surface ?? 'cli',
      ...(actionId === 'session.stop' && !context?.bypassApprovals && !context?.messageSource && params.sessionId !== 'cli-global'
        ? { messageSource: { sourceSessionId: params.sessionId, via: 'action' as const } }
        : {}),
      ...(callerPermissionMode ? { callerPermissionMode } : {}),
      actionsSettings: readActionsSettingsFromEnv(),
    };
  };

  return {
    prepare: async (actionId, input, context) => await base.prepare(
      actionId,
      input,
      withCliContext(actionId, context),
    ),
    execute: async (actionId, input, context) => {
      return await base.execute(actionId, input, withCliContext(actionId, context));
    },
  };
}
