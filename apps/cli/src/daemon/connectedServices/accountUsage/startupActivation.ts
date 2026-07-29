import type { ConnectedServiceId, ConnectedServiceUsageSourceV1 } from '@happier-dev/protocol';

export async function activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration<
  TCoordinator extends Readonly<{
    scheduleCurrentSourceRefresh: (sources: readonly ConnectedServiceUsageSourceV1[]) => unknown;
  }>,
  TLoopHandle,
>(input: Readonly<{
  enabled: boolean;
  quotaFetchers: readonly Readonly<{ serviceId: ConnectedServiceId }>[];
  awaitReadiness: () => Promise<void>;
  hydrate: (input: Readonly<{ serviceIds: readonly ConnectedServiceId[] }>) => Promise<Readonly<{
    refreshSources: ConnectedServiceUsageSourceV1[];
  }>>;
  createCoordinator: () => TCoordinator;
  startLoop: (coordinator: TCoordinator) => TLoopHandle;
  onActivationError: (error: unknown) => void;
}>): Promise<
  | Readonly<{ status: 'disabled' }>
  | Readonly<{ status: 'quota_policy_disabled'; error: unknown }>
  | Readonly<{ status: 'active'; coordinator: TCoordinator; loopHandle: TLoopHandle }>
> {
  if (!input.enabled) return { status: 'disabled' };
  const serviceIds = [...new Set(input.quotaFetchers.map((fetcher) => fetcher.serviceId))];
  try {
    await input.awaitReadiness();
    const hydration = await input.hydrate({ serviceIds });
    const coordinator = input.createCoordinator();
    coordinator.scheduleCurrentSourceRefresh(hydration.refreshSources);
    const loopHandle = input.startLoop(coordinator);
    return { status: 'active', coordinator, loopHandle };
  } catch (error) {
    input.onActivationError(error);
    return { status: 'quota_policy_disabled', error };
  }
}
