import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

export function createCliActionExecutor(
  params: Parameters<typeof createCliActionExecutorHarness>[0],
): ReturnType<typeof createCliActionExecutorHarness>['executor'] {
  const base = createCliActionExecutorHarness(params).executor;

  return {
    execute: async (actionId, input, context) =>
      await base.execute(actionId, input, {
        ...(context ?? {}),
        surface: context?.surface ?? 'cli',
      }),
  };
}
