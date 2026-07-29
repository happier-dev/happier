import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';

import { parseConnectedServiceBindingSelections } from './parseConnectedServicesBindings';

type TrackedConnectedServiceBindingSource = Pick<
  TrackedSession,
  'happySessionMetadataFromLocalWebhook' | 'spawnOptions'
>;

export function resolveTrackedConnectedServiceBindingsRaw(
  tracked: TrackedConnectedServiceBindingSource,
): unknown {
  return tracked.spawnOptions?.connectedServices ?? tracked.happySessionMetadataFromLocalWebhook?.connectedServices;
}

export function hasTrackedConnectedServiceGroupBinding(input: Readonly<{
  tracked: TrackedConnectedServiceBindingSource;
  serviceId: ConnectedServiceId;
  groupId: string;
}>): boolean {
  return parseConnectedServiceBindingSelections(resolveTrackedConnectedServiceBindingsRaw(input.tracked))
    .some((selection) => (
      selection.kind === 'group'
      && selection.serviceId === input.serviceId
      && selection.groupId === input.groupId
    ));
}
