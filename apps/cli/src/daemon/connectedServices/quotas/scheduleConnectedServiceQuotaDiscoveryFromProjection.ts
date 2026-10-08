import type { ConnectedServiceProjectionSnapshot } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import type { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceQuotasLoopHandle } from './startConnectedServiceQuotasLoop';

/** Feeds committed profile inventory to the existing quota coordinator and wakes its loop only for newly discovered profiles. */
export function scheduleConnectedServiceQuotaDiscoveryFromProjection(input: Readonly<{
  coordinator: ConnectedServiceQuotasCoordinator | null;
  loop: ConnectedServiceQuotasLoopHandle | null;
  projection: ConnectedServiceProjectionSnapshot;
}>): void {
  if (!input.coordinator || !input.loop) return;
  const added = input.coordinator.updateDiscoveredProfiles(input.projection.credentials.filter((credential) => credential.boundary.status === 'present'));
  if (added) input.loop.requestTick();
}

// Quota inventory consumes committed account truth independently of applying auth
// to a live provider runtime. Runtime rejection must still propagate to its owner.
/** Schedules read-only quotas before runtime auth application, allowing runtime failures to propagate unchanged. */
export async function reconcileConnectedServiceProjectionWithQuotaDiscovery<T>(input: Readonly<{
  coordinator: ConnectedServiceQuotasCoordinator | null;
  loop: ConnectedServiceQuotasLoopHandle | null;
  projection: ConnectedServiceProjectionSnapshot;
  reconcile: () => Promise<T>;
}>): Promise<T> {
  scheduleConnectedServiceQuotaDiscoveryFromProjection(input);
  return await input.reconcile();
}
