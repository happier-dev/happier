import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

export function createCliActionExecutor(
  params: Parameters<typeof createCliActionExecutorHarness>[0],
): ReturnType<typeof createCliActionExecutorHarness>['executor'] {
  return createCliActionExecutorHarness(params).executor;
}
