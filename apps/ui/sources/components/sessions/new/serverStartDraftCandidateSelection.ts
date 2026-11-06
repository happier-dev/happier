import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { getServerProfileById, readServerProfileHomeName } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { leafFolderName } from '@/utils/path/pathUtils';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { normalizeLocalPathForComparison } from '@/utils/path/resolvePathRelativeToRoot';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { resolveMachineDisplayNames, type MachineNameSource } from '@/utils/sessions/machineDisplayNames';

import type {
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';

type Candidate = NonNullable<SessionServerStartDraftSeed['candidates']>[number];

export function resolveSessionServerStartCandidateSelection(params: Readonly<{
    mountedTarget: SessionServerStartDraftTarget;
    accountScope?: MachineReachabilityScope | null;
    selectedCandidate?: Candidate;
    activeServerId: string;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>): Readonly<{
    candidate?: Candidate;
    target: SessionServerStartDraftTarget;
    machine: Machine | null;
    directory?: string;
    machineReady: boolean;
}> {
    const target = params.selectedCandidate === undefined
        ? params.mountedTarget
        : {
            serverId: params.selectedCandidate.serverId,
            machineId: params.selectedCandidate.machineId,
        };
    const machine = resolveExactServerScopedMachine({
        machineId: target.machineId,
        serverId: target.serverId,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
        machineListStatusByServerId: params.machineListStatusByServerId,
    });

    return {
        ...(params.selectedCandidate === undefined ? {} : { candidate: params.selectedCandidate }),
        target,
        machine,
        ...(params.selectedCandidate === undefined ? {} : { directory: params.selectedCandidate.rootPath }),
        machineReady: resolveMachineSpawnReadiness({
            machine,
            selectedMachineId: target.machineId,
            scope: selectActiveServerAccountScopeForServer(params.accountScope ?? null, target.serverId),
        }).status === 'ready',
    };
}

/**
 * The candidate the working directory currently stands for: same Home and Machine as the chosen target, same
 * folder. A folder typed or browsed to that no candidate names selects none, while the chosen Machine and Home stay
 * the target; the checkout rows never claim a directory the reader moved away from.
 */
export function findSessionServerStartCandidateForDirectory(params: Readonly<{
    candidates: readonly Candidate[] | undefined;
    target: SessionServerStartDraftTarget;
    directory: string;
}>): number {
    const directory = normalizeLocalPathForComparison(params.directory);
    if (directory === null || params.candidates === undefined) return -1;
    return params.candidates.findIndex((candidate) => (
        candidate.serverId === params.target.serverId
        && candidate.machineId === params.target.machineId
        && normalizeLocalPathForComparison(candidate.rootPath) === directory
    ));
}

export type SessionPlacementCandidateRow = Readonly<{
    candidate: Candidate;
    /** The candidate's position in the list it came from; rows are ordered by availability. */
    index: number;
    title: string;
    subtitle: string | undefined;
    availability: 'available' | 'unknown' | 'unavailable';
}>;

/** The words the Machine picker uses, sharper where a Machine is gone. An unlisted Machine's own name says why. */
function placementUnavailableReason(readiness: ReturnType<typeof resolveMachineSpawnReadiness>['status']): string | null {
    switch (readiness) {
        case 'offline': return t('status.offline');
        case 'revoked': return t('machine.removedMachine');
        case 'replaced': return t('machine.replacedMachine');
        case 'missing': return null;
        default: return t('common.unavailable');
    }
}

/**
 * What the saved-project rows say, for every New Session entry: which project, then line 2 with a reason that
 * leads when it cannot start there, the Machine (named as a set, as Sessions and Search do) and its folder. Live
 * rows come first. Raw Machine and Home ids are never shown. A list that has not answered claims nothing.
 */
export function presentSessionPlacementCandidates(params: Readonly<{
    candidates: readonly Candidate[];
    accountScope?: MachineReachabilityScope | null;
    activeServerId: string;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
    nowMs?: number;
}>): readonly SessionPlacementCandidateRow[] {
    const resolved = params.candidates.map((candidate, index) => ({ candidate, index, machine: resolveExactServerScopedMachine({
        machineId: candidate.machineId,
        serverId: candidate.serverId,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
        machineListStatusByServerId: params.machineListStatusByServerId,
    }) }));
    const spansHomes = new Set(params.candidates.map((candidate) => candidate.serverId)).size > 1;
    const namesByServerId = new Map<string, ReadonlyMap<string, string>>();
    const machineNames = (serverId: string) => {
        const known = namesByServerId.get(serverId);
        if (known) return known;
        const sources = new Map<string, MachineNameSource>();
        for (const { candidate, machine } of resolved) {
            if (candidate.serverId === serverId) sources.set(candidate.machineId, machine ?? { id: candidate.machineId, absence: 'unlisted' });
        }
        const names = resolveMachineDisplayNames([...sources.values()]);
        namesByServerId.set(serverId, names);
        return names;
    };
    const rows = resolved.map(({ candidate, index, machine }) => {
        const listStatus = params.machineListStatusByServerId?.[candidate.serverId];
        const listSettled = candidate.serverId === params.activeServerId || listStatus === 'idle'
            || params.machineListByServerId[candidate.serverId] != null;
        // An absent Machine is only known to be gone once its Home's list has answered.
        const answered = machine !== null || (listSettled && (listStatus === undefined || listStatus === 'idle'));
        const readiness = resolveMachineSpawnReadiness({
            machine,
            selectedMachineId: candidate.machineId,
            scope: selectActiveServerAccountScopeForServer(params.accountScope ?? null, candidate.serverId),
            ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
        }).status;
        const availability = !answered || readiness === 'unknown' ? 'unknown' : readiness === 'ready' ? 'available' : 'unavailable';
        const profile = spansHomes ? getServerProfileById(candidate.serverId) : null;
        const subtitle = [
            availability === 'unavailable' ? placementUnavailableReason(readiness) : null,
            answered ? machineNames(candidate.serverId).get(candidate.machineId) ?? null : null,
            formatSessionPath(candidate.rootPath, machine?.metadata?.homeDir ?? undefined),
            profile ? readServerProfileHomeName(profile) : null,
        ].filter(Boolean).join(' · ');
        return {
            // Live first, then unconfirmed; an offline Machine can come back, so it stands above one that is gone.
            rank: availability === 'available' ? 0 : availability === 'unknown' ? 1 : readiness === 'offline' ? 2 : 3,
            row: {
                candidate,
                index,
                title: candidate.label ?? leafFolderName(candidate.rootPath) ?? candidate.rootPath,
                subtitle: subtitle || undefined,
                availability,
            } satisfies SessionPlacementCandidateRow,
        };
    });
    return rows.sort((left, right) => left.rank - right.rank).map((entry) => entry.row);
}
