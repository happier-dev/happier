import { readConnectedServiceChildSelectionsFromEnv } from '../connectedServiceChildEnvironment';
import type { ConnectedServiceMaterializedTargetsByServiceId } from './connectedServiceAuthSwitchOutcome';

/** Project only this application's handed child selections; retained targets are not application evidence. */
export function readMaterializedApplicationTargets(
  environmentVariables: Record<string, string> | undefined,
  serviceIds: ReadonlySet<string>,
): Readonly<{ materializedTargetByServiceId?: ConnectedServiceMaterializedTargetsByServiceId }> {
  const targets: Record<string, ConnectedServiceMaterializedTargetsByServiceId[string]> = {};
  for (const selection of readConnectedServiceChildSelectionsFromEnv(environmentVariables ?? {})?.values() ?? []) {
    if (selection.kind !== 'group' || !serviceIds.has(selection.serviceId) || !selection.credentialRevision) continue;
    targets[selection.serviceId] = { serviceId: selection.serviceId, groupId: selection.groupId,
      profileId: selection.activeProfileId, generation: selection.generation, credentialRevision: selection.credentialRevision };
  }
  return Object.keys(targets).length ? { materializedTargetByServiceId: targets } : {};
}
