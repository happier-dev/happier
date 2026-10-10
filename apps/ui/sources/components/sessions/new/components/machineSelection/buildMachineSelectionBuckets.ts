import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { buildMachineOwnershipGroups } from '@/sync/domains/machines/machineOwnershipGroups';

import { resolveMachinePickerPresence } from '../resolveMachinePickerPresence';

export type MachineSelectionBucketId = 'recent' | 'favorites' | 'all' | 'shared';
export type MachineSelectionFavoriteGroupPlacement = 'beforeRecent' | 'afterRecent';

export type MachineSelectionBucket<TMachine extends MachineDisplayRenderable = Machine> = Readonly<{
    id: MachineSelectionBucketId;
    key?: string;
    custodian?: NonNullable<Machine['access']>['custodian'];
    machines: ReadonlyArray<TMachine>;
}>;

export type MachineSelectionBuckets<TMachine extends MachineDisplayRenderable = Machine> = Readonly<{
    buckets: ReadonlyArray<MachineSelectionBucket<TMachine>>;
    visibleMachines: ReadonlyArray<TMachine>;
    recentMachinesWithoutFavorites: ReadonlyArray<TMachine>;
    favoriteMachines: ReadonlyArray<TMachine>;
    allMachines: ReadonlyArray<TMachine>;
    favoriteMachineIdSet: ReadonlySet<string>;
}>;

export type BuildMachineSelectionBucketsParams<TMachine extends MachineDisplayRenderable = Machine> = Readonly<{
    machines: ReadonlyArray<TMachine>;
    recentMachines?: ReadonlyArray<TMachine>;
    favoriteMachines?: ReadonlyArray<TMachine>;
    showFavorites?: boolean;
    showRecent?: boolean;
    disableOfflineMachines?: boolean;
    favoriteGroupPlacement?: MachineSelectionFavoriteGroupPlacement;
    includeSelectedUnavailableMachineId?: string | null;
}>;

function isMachineSelectableForLaunch(machine: MachineDisplayRenderable): boolean {
    return resolveMachinePickerPresence(machine).selectable;
}

function prioritizeSelectableMachines<T extends MachineDisplayRenderable>(machines: ReadonlyArray<T>): T[] {
    return machines
        .map((machine, index) => ({ machine, index, selectable: isMachineSelectableForLaunch(machine) }))
        .sort((left, right) => {
            if (left.selectable !== right.selectable) return left.selectable ? -1 : 1;
            return left.index - right.index;
        })
        .map((entry) => entry.machine);
}

export function buildMachineSelectionBuckets<TMachine extends MachineDisplayRenderable = Machine>(
    params: BuildMachineSelectionBucketsParams<TMachine>,
): MachineSelectionBuckets<TMachine> {
    const showFavorites = params.showFavorites ?? true;
    const showRecent = params.showRecent ?? true;
    const disableOfflineMachines = params.disableOfflineMachines ?? true;
    const favoriteGroupPlacement = params.favoriteGroupPlacement ?? 'afterRecent';

    const isVisible = (machine: TMachine) => isMachineVisibleForLaunchSelection(machine)
        || machine.id === params.includeSelectedUnavailableMachineId;
    const visibleMachines = params.machines.filter(isVisible);
    const visibleRecentMachines = (params.recentMachines ?? []).filter(isVisible);
    const visibleFavoriteMachines = (params.favoriteMachines ?? []).filter(isVisible);

    const launchPinnedRecentMachines = disableOfflineMachines
        ? visibleRecentMachines.filter(isMachineSelectableForLaunch)
        : visibleRecentMachines;
    const launchPinnedFavoriteMachines = disableOfflineMachines
        ? visibleFavoriteMachines.filter(isMachineSelectableForLaunch)
        : visibleFavoriteMachines;

    const favoriteMachineIdSet = showFavorites
        ? new Set<string>(launchPinnedFavoriteMachines.map((machine) => machine.id))
        : new Set<string>();

    const recentMachinesWithoutFavorites = !showRecent || favoriteMachineIdSet.size === 0
        ? launchPinnedRecentMachines
        : launchPinnedRecentMachines.filter((machine) => !favoriteMachineIdSet.has(machine.id));

    const pinnedIds = new Set<string>();
    if (showFavorites) {
        for (const machine of launchPinnedFavoriteMachines) pinnedIds.add(machine.id);
    }
    if (showRecent) {
        for (const machine of recentMachinesWithoutFavorites) pinnedIds.add(machine.id);
    }

    const unpinnedMachines = pinnedIds.size === 0
        ? visibleMachines
        : visibleMachines.filter((machine) => !pinnedIds.has(machine.id));
    const allMachines = disableOfflineMachines
        ? prioritizeSelectableMachines(unpinnedMachines)
        : unpinnedMachines;

    const recentBucket: MachineSelectionBucket<TMachine> = {
        id: 'recent',
        machines: showRecent ? recentMachinesWithoutFavorites : [],
    };
    const favoritesBucket: MachineSelectionBucket<TMachine> = {
        id: 'favorites',
        machines: showFavorites ? launchPinnedFavoriteMachines : [],
    };
    const allBuckets: MachineSelectionBucket<TMachine>[] = buildMachineOwnershipGroups(allMachines).map((group) => ({
        id: group.key.startsWith('shared:') ? 'shared' : 'all',
        key: group.key === 'owned' ? 'all' : group.key,
        ...(group.custodian ? { custodian: group.custodian } : {}),
        machines: group.machines,
    }));

    const leadingBuckets = favoriteGroupPlacement === 'beforeRecent'
        ? [favoritesBucket, recentBucket]
        : [recentBucket, favoritesBucket];

    return {
        buckets: [...leadingBuckets, ...allBuckets].filter((bucket) => bucket.machines.length > 0),
        visibleMachines,
        recentMachinesWithoutFavorites,
        favoriteMachines: launchPinnedFavoriteMachines,
        allMachines,
        favoriteMachineIdSet,
    };
}
