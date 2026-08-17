import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';

import { resolveMachinePickerPresence } from '../resolveMachinePickerPresence';

export type MachineSelectionBucketId = 'recent' | 'favorites' | 'all';
export type MachineSelectionFavoriteGroupPlacement = 'beforeRecent' | 'afterRecent';

export type MachineSelectionBucket = Readonly<{
    id: MachineSelectionBucketId;
    machines: ReadonlyArray<Machine>;
}>;

export type MachineSelectionBuckets = Readonly<{
    buckets: ReadonlyArray<MachineSelectionBucket>;
    visibleMachines: ReadonlyArray<Machine>;
    recentMachinesWithoutFavorites: ReadonlyArray<Machine>;
    favoriteMachines: ReadonlyArray<Machine>;
    allMachines: ReadonlyArray<Machine>;
    favoriteMachineIdSet: ReadonlySet<string>;
}>;

export type BuildMachineSelectionBucketsParams = Readonly<{
    machines: ReadonlyArray<Machine>;
    recentMachines?: ReadonlyArray<Machine>;
    favoriteMachines?: ReadonlyArray<Machine>;
    showFavorites?: boolean;
    showRecent?: boolean;
    disableOfflineMachines?: boolean;
    favoriteGroupPlacement?: MachineSelectionFavoriteGroupPlacement;
}>;

function isMachineSelectableForLaunch(machine: Machine): boolean {
    return resolveMachinePickerPresence(machine).selectable;
}

function prioritizeSelectableMachines<T extends Machine>(machines: ReadonlyArray<T>): T[] {
    return machines
        .map((machine, index) => ({ machine, index, selectable: isMachineSelectableForLaunch(machine) }))
        .sort((left, right) => {
            if (left.selectable !== right.selectable) return left.selectable ? -1 : 1;
            return left.index - right.index;
        })
        .map((entry) => entry.machine);
}

export function buildMachineSelectionBuckets(params: BuildMachineSelectionBucketsParams): MachineSelectionBuckets {
    const showFavorites = params.showFavorites ?? true;
    const showRecent = params.showRecent ?? true;
    const disableOfflineMachines = params.disableOfflineMachines ?? true;
    const favoriteGroupPlacement = params.favoriteGroupPlacement ?? 'afterRecent';

    const visibleMachines = params.machines.filter(isMachineVisibleForLaunchSelection);
    const visibleRecentMachines = (params.recentMachines ?? []).filter(isMachineVisibleForLaunchSelection);
    const visibleFavoriteMachines = (params.favoriteMachines ?? []).filter(isMachineVisibleForLaunchSelection);

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

    const recentBucket: MachineSelectionBucket = {
        id: 'recent',
        machines: showRecent ? recentMachinesWithoutFavorites : [],
    };
    const favoritesBucket: MachineSelectionBucket = {
        id: 'favorites',
        machines: showFavorites ? launchPinnedFavoriteMachines : [],
    };
    const allBucket: MachineSelectionBucket = {
        id: 'all',
        machines: allMachines,
    };

    const leadingBuckets = favoriteGroupPlacement === 'beforeRecent'
        ? [favoritesBucket, recentBucket]
        : [recentBucket, favoritesBucket];

    return {
        buckets: [...leadingBuckets, allBucket].filter((bucket) => bucket.machines.length > 0),
        visibleMachines,
        recentMachinesWithoutFavorites,
        favoriteMachines: launchPinnedFavoriteMachines,
        allMachines,
        favoriteMachineIdSet,
    };
}
