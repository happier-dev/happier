import type { ConnectedServiceId } from '@happier-dev/protocol';

import type { ConnectedServiceRuntimeTarget } from './runtimeRegistry/registry';

export type ConnectedServiceRuntimeAuthRefreshSelection = Readonly<
  | {
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
    }
  | {
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
    }
>;

/**
 * Whether a live runtime-registry target owns the requested session runtime-auth selection.
 */
export function runtimeTargetOwnsConnectedServiceRuntimeAuthRefreshSelection(input: Readonly<{
  target: ConnectedServiceRuntimeTarget;
  selection: ConnectedServiceRuntimeAuthRefreshSelection;
}>): boolean {
  if (input.selection.kind === 'profile') {
    const requested = input.selection;
    return input.target.boundProfiles.some((bound) => (
      bound.serviceId === requested.serviceId
      && bound.profileId === requested.profileId
    ));
  }
  const requested = input.selection;
  const envSelection = input.target.connectedServiceSelections
    .find((selection) => selection.serviceId === requested.serviceId) ?? null;
  return envSelection?.kind === 'group'
    && envSelection.groupId === requested.groupId
    && envSelection.activeProfileId === requested.activeProfileId
    && envSelection.fallbackProfileId === requested.fallbackProfileId
    && envSelection.generation === requested.generation;
}
