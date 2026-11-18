import type { WorkflowProjectTargetV1 } from '@happier-dev/protocol/workflows';

import { resolvePreferredLaunchMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveDefaultDirectoryForMachine } from '@/utils/sessions/machineDefaultDirectory';

/**
 * The contextual Machine and project folder a new workflow draft starts with.
 *
 * UX §2.3: a neutral entry uses the canonical default resolver **only when it
 * produces a valid contextual choice**, and an unresolved target stays visibly
 * unresolved. So this returns `null` rather than half a target: a Machine with
 * no known folder is not a workable default, and inventing one would make the
 * screen look complete while Run now still could not proceed.
 *
 * Both halves come from the owners ordinary Session authoring already uses —
 * `resolvePreferredLaunchMachineId` and the Account's recent machine paths — so a
 * workflow and a new Session opened side by side agree about "where".
 */

type RecentMachinePath = Readonly<{ machineId?: string | null; path?: string | null }>;

export function resolveContextualWorkflowProjectTarget(params: Readonly<{
    machines: readonly Machine[];
    scope?: MachineReachabilityScope | null;
    recentMachinePaths: readonly RecentMachinePath[];
    /** A captured Session's machine, when the draft was opened from one. */
    preferredMachineId?: string | null;
}>): WorkflowProjectTargetV1 | null {
    const machineId = resolvePreferredLaunchMachineId({
        machines: params.machines,
        scope: params.scope,
        recentMachinePaths: params.recentMachinePaths,
        preferredMachineId: params.preferredMachineId ?? null,
    });
    // A remembered machine the Account no longer lists is not a contextual
    // default: the resolver can still name it from recent paths, but this client
    // cannot resolve, reach or validate it.
    const machine = machineId === null
        ? undefined
        : params.machines.find((candidate) => candidate.id === machineId);
    if (!machineId || machine === undefined) return null;
    return resolveWorkflowProjectTargetOnMachine({ ...params, machineId });
}

/**
 * A named Machine's starting place (an event's own Machine): that exact Machine, online or not, with its
 * folder from the same default-directory policy. `null` when this client cannot list it or knows no folder.
 */
export function resolveWorkflowProjectTargetOnMachine(params: Readonly<{
    machineId: string;
    machines: readonly Machine[];
    recentMachinePaths: readonly RecentMachinePath[];
}>): WorkflowProjectTargetV1 | null {
    const { machineId } = params;
    if (!params.machines.some((candidate) => candidate.id === machineId)) return null;
    // Where a Machine starts is the shared default-directory policy New
    // Session uses, not a second "recent path, else home" rule kept here.
    const directory = resolveDefaultDirectoryForMachine({
        machineId,
        machines: params.machines,
        recentPaths: params.recentMachinePaths
            .filter((entry) => entry?.machineId === machineId)
            .map((entry) => entry.path)
            .filter((path): path is string => typeof path === 'string'),
    }).trim();
    if (directory.length === 0) return null;

    return { machineId, directory };
}
