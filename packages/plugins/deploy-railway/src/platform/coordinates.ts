import { deploymentTargetRoleWithNativeSelectorV1, type DeploymentTargetRoleCommonInputV1 } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const railwayId = defineProtocolString({ minLength: 1 });
const railwaySelector = defineProtocolObject({ projectId: railwayId, environmentId: railwayId, serviceId: railwayId.optional() }, { policy: 'closed' });
type RailwaySelection = ProtocolSchemaOutput<typeof railwaySelector>;
export type RailwayEnvironment = Readonly<{ kind: 'native'; selection: RailwaySelection }>;
export const railwaySelectorSchema = railwaySelector.jsonSchema;

export function railwayRoleInput(base: Parameters<typeof deploymentTargetRoleWithNativeSelectorV1>[0]) {
  return deploymentTargetRoleWithNativeSelectorV1(base, railwaySelectorSchema);
}

/** The target's closed Action schema has already validated all three native IDs. */
export function readRailwayCoordinates({ providerIdentity, providerEnvironment }:
  Pick<DeploymentTargetRoleCommonInputV1, 'providerIdentity' | 'providerEnvironment'>): {
    projectId: string; environmentId: string; serviceId: string;
  } {
  if (providerEnvironment.selection.projectId !== providerIdentity.providerAccountId
    || providerEnvironment.selection.environmentId !== providerIdentity.providerEnvironment
    || providerEnvironment.selection.serviceId !== providerIdentity.providerResourceId) {
    throw new PluginError({ code: 'target_mismatch' });
  }
  return { projectId: providerIdentity.providerAccountId, environmentId: providerIdentity.providerEnvironment,
    serviceId: providerIdentity.providerResourceId };
}
