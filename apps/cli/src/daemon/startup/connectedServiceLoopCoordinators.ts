import type { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import type { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';

type AccountOperation = <T>(operation: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

export function createConnectedServiceRefreshLoopCoordinator(input: Readonly<{
  coordinator: Pick<ConnectedServiceRefreshCoordinator, 'tickOnce'>;
  skipQualified: boolean;
  runAccountOperation?: AccountOperation;
}>) {
  return { tickOnce: async (options?: Readonly<{ signal?: AbortSignal }>) => {
    const signal = options?.signal;
    signal?.throwIfAborted();
    // Selected reads and effects keep their own fresh authority checks.
    const operation = () => input.coordinator.tickOnce({ skipQualified: input.skipQualified, signal });
    return await (input.runAccountOperation ? input.runAccountOperation(operation, signal) : operation());
  } };
}

export function createConnectedServiceQuotaLoopCoordinator(input: Readonly<{
  coordinator: Pick<ConnectedServiceQuotasCoordinator, 'tickOnce'>;
  isAccountRuntimeCurrent?: (signal?: AbortSignal) => Promise<boolean>;
  runAccountOperation?: AccountOperation;
}>) {
  return { tickOnce: async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (input.isAccountRuntimeCurrent && !await input.isAccountRuntimeCurrent(signal)) return { nextAutomaticRunAfterMs: null };
    signal?.throwIfAborted();
    const operation = () => input.coordinator.tickOnce(signal);
    return await (input.runAccountOperation ? input.runAccountOperation(operation, signal) : operation());
  } };
}
