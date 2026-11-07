import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    readMachineAgentIsolationPolicyV1,
    resolveMachineAgentExecutionPlacementV1,
    type MachineAgentIsolationOwnStatusV1,
} from '@happier-dev/protocol/machines/agentIsolationV1';

type MachineDirectoryInput = Readonly<{
    machine: Machine | null | undefined;
    ownStatus?: MachineAgentIsolationOwnStatusV1 | null;
}>;

export function hasUnresolvedRequesterDirectories({ machine, ownStatus }: MachineDirectoryInput): boolean {
    if (ownStatus?.protection === 'member_separated') return !ownStatus.directories;
    if (!machine) return false;
    if (!machine.metadata) return machine.isShared === true;
    const policy = readMachineAgentIsolationPolicyV1(machine.metadata);
    if (policy.status === 'ready' && resolveMachineAgentExecutionPlacementV1({
        policy: policy.policy, platform: machine.metadata.platform,
    }) === 'member') return true;
    if (!machine.isShared) return false;
    if (ownStatus && ownStatus.protection !== 'unavailable' && ownStatus.protection !== 'setup_pending') return false;
    // Non-isolated sessions run as the daemon user. Isolation readiness cannot
    // supply a member directory there (macOS reports unsupported_platform).
    return policy.status !== 'ready' || resolveMachineAgentExecutionPlacementV1({
        policy: policy.policy, platform: machine.metadata.platform,
    }) !== 'daemon';
}

/** Home expansion and automatic placement consume the same requester-owned fact. */
export function resolveMachineHomeDirectory({ machine, ownStatus }: MachineDirectoryInput): string {
    if (ownStatus?.protection === 'member_separated') return ownStatus.directories?.home ?? '';
    if (hasUnresolvedRequesterDirectories({ machine, ownStatus })) return '';
    return machine?.metadata?.homeDir ?? '';
}

/**
 * Where work on a Machine starts when the author has not chosen a folder.
 *
 * A separated requester starts in their provisioned workspace. Otherwise the
 * most recent folder is the answer; the home
 * intent is the fallback for a Machine they have not used yet. Its native
 * execution owner expands `~`, which may differ from the daemon's home. New Session
 * and the Workflow editor both need this, and a second "just use homeDir"
 * policy made the same Machine open somewhere else depending on which page
 * selected it.
 */
export function resolveDefaultDirectoryForMachine(input: Readonly<{
    machineId: string | null | undefined;
    machines: ReadonlyArray<Machine>;
    recentPaths: ReadonlyArray<string>;
    ownStatus?: MachineAgentIsolationOwnStatusV1 | null;
}>): string {
    const machineId = typeof input.machineId === 'string' ? input.machineId.trim() : '';
    if (!machineId) return '';
    const machine = input.machines.find((machine) => machine.id === machineId);
    if (input.ownStatus?.protection === 'member_separated') return input.ownStatus.directories?.workspace ?? '';
    if (hasUnresolvedRequesterDirectories({ machine, ownStatus: input.ownStatus })) return '';
    const recent = input.recentPaths.find((path) => typeof path === 'string' && path.trim().length > 0);
    if (recent !== undefined) return recent;
    return machine?.metadata?.homeDir ? '~' : '';
}
