import type {
  ConnectedServiceId,
  ConnectedServiceUsageSourceV1,
} from '@happier-dev/protocol';

import type { DaemonServerWorkRequest, DaemonServerWorkScheduler } from '../../serverWork/types';

export async function activateConnectedServiceQuotaAutomationAfterProviderAccountUsageHydration<
  TCoordinator extends Readonly<{
    scheduleCurrentSourceRefresh: (sources: readonly ConnectedServiceUsageSourceV1[]) => unknown;
  }>,
  TLoopHandle,
>(input: Readonly<{
  enabled: boolean;
  serverWorkScheduler: DaemonServerWorkScheduler;
  retry: NonNullable<DaemonServerWorkRequest<null>['retry']>;
  quotaFetchers: readonly Readonly<{ serviceId: ConnectedServiceId }>[];
  awaitReadiness: () => Promise<void>;
  hydrate: (input: Readonly<{
    serviceIds: readonly ConnectedServiceId[];
  }>) => Promise<Readonly<{
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
  let activation: Readonly<{ status: 'active'; coordinator: TCoordinator; loopHandle: TLoopHandle }> | undefined;
  let activationError: unknown;
  const outcome = await input.serverWorkScheduler.enqueue({
    key: 'connectedServiceQuotaActivation',
    purpose: 'connectedServiceQuotaActivation',
    kind: 'livenessReadiness',
    payload: null,
    payloadBytes: 0,
    retry: input.retry,
    run: async () => {
      try {
        await input.awaitReadiness();
        if (input.retry.signal.aborted) return;
        const hydration = await input.hydrate({ serviceIds });
        if (input.retry.signal.aborted) return;
        const coordinator = input.createCoordinator();
        coordinator.scheduleCurrentSourceRefresh(hydration.refreshSources);
        const loopHandle = input.startLoop(coordinator);
        activation = { status: 'active', coordinator, loopHandle };
      } catch (error) {
        activationError = error;
        throw error;
      }
    },
  });
  if (input.retry.signal.aborted || outcome.status === 'suppressed') return { status: 'disabled' };
  if (activation) return activation;
  input.onActivationError(activationError);
  return { status: 'quota_policy_disabled', error: activationError };
}
