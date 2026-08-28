import {
    arePluginMachineExecutionOriginsEqual,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';

export type PluginContributionIdentity = Readonly<{ pluginId: string; localId: string }>;
export type FreshPluginMachineExecutionOriginComparable = Readonly<{
    origin: PluginMachineExecutionOriginV1;
    machineTarget: Readonly<{
        serverId: string | null;
        target: Readonly<{ serverIdentityId: string; machineId: string }>;
    }>;
}>;

export function arePluginContributionIdentitiesEqual(
    left: PluginContributionIdentity,
    right: PluginContributionIdentity,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

export function areFreshPluginMachineExecutionOriginsCurrent(
    left: FreshPluginMachineExecutionOriginComparable,
    right: FreshPluginMachineExecutionOriginComparable,
): boolean {
    return arePluginMachineExecutionOriginsEqual(left.origin, right.origin)
        && left.machineTarget.serverId === right.machineTarget.serverId
        && left.machineTarget.target.serverIdentityId === right.machineTarget.target.serverIdentityId
        && left.machineTarget.target.machineId === right.machineTarget.target.machineId;
}
