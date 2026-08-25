import {
    arePluginMachineExecutionOriginsEqual,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';

/** Exact contribution identity: neither field alone identifies a plugin leaf. */
export type PluginContributionIdentity = Readonly<{
    pluginId: string;
    localId: string;
}>;

/** The materialization identity shared by Event setup, drafts, and recovery. */
export type PluginMachineMaterializationRef = Readonly<{
    pluginId: string;
    machineId: string;
    materializationId: string;
}>;

/**
 * The UI-only comparison shape for a re-resolved execution origin. It records
 * the target facts that the lower-level origin schema deliberately does not
 * own, while leaving selection and freshness resolution to their existing
 * owners.
 */
export type FreshPluginMachineExecutionOriginComparable = Readonly<{
    origin: PluginMachineExecutionOriginV1;
    machineTarget: Readonly<{
        serverId: string | null;
        target: Readonly<{
            serverIdentityId: string;
            machineId: string;
        }>;
    }>;
}>;

export function arePluginContributionIdentitiesEqual(
    left: PluginContributionIdentity,
    right: PluginContributionIdentity,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

export function arePluginMachineMaterializationRefsEqual(
    left: PluginMachineMaterializationRef,
    right: PluginMachineMaterializationRef,
): boolean {
    return left.pluginId === right.pluginId
        && left.machineId === right.machineId
        && left.materializationId === right.materializationId;
}

/** A persisted origin stays current only when its exact protocol identity does. */
export function arePluginMachineExecutionOriginsCurrent(
    left: PluginMachineExecutionOriginV1,
    right: PluginMachineExecutionOriginV1,
): boolean {
    return arePluginMachineExecutionOriginsEqual(left, right);
}

/**
 * Effect admission also binds the resolved server/machine target, so an equal
 * persisted origin cannot accidentally authorize work on a replacement target.
 */
export function areFreshPluginMachineExecutionOriginsCurrent(
    left: FreshPluginMachineExecutionOriginComparable,
    right: FreshPluginMachineExecutionOriginComparable,
): boolean {
    return arePluginMachineExecutionOriginsCurrent(left.origin, right.origin)
        && left.machineTarget.serverId === right.machineTarget.serverId
        && left.machineTarget.target.serverIdentityId === right.machineTarget.target.serverIdentityId
        && left.machineTarget.target.machineId === right.machineTarget.target.machineId;
}
