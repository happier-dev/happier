import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { executePluginActionIfAvailable } from '@/plugins/projection/actions/execute';

export function createCliActionExecutor(
  params: Parameters<typeof createCliActionExecutorHarness>[0],
): ReturnType<typeof createCliActionExecutorHarness>['executor'] {
  const base = createCliActionExecutorHarness(params).executor;

  return {
    execute: async (actionId, input, context) => {
      const resolvedContext = {
        ...(context ?? {}),
        surface: context?.surface ?? 'cli',
      };
      const pluginAction = await executePluginActionIfAvailable({
        happyHomeDir: params.happyHomeDir,
        actionId,
        input,
        context: {
          ...(typeof resolvedContext.defaultSessionId === 'string' ? { defaultSessionId: resolvedContext.defaultSessionId } : {}),
          surface: resolvedContext.surface === 'mcp' || resolvedContext.surface === 'session_agent'
            ? resolvedContext.surface
            : 'cli',
        },
      });
      if (pluginAction.matched) {
        return pluginAction.result;
      }

      return await base.execute(actionId, input, resolvedContext);
    },
  };
}
