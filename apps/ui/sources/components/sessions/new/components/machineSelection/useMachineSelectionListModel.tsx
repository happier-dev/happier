import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type {
    SelectionListOption,
    SelectionListSectionDescriptor,
    SelectionListStep,
} from '@/components/ui/selectionList';
import { t } from '@/text';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type {
    ServerScopedMachine,
    ServerScopedMachineGroup,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

import {
    buildMachineSelectionBuckets,
    type MachineSelectionBucketId,
    type MachineSelectionFavoriteGroupPlacement,
} from './buildMachineSelectionBuckets';
import { MachineSelectionRowAccessory } from './MachineSelectionRowAccessory';
import { resolveMachinePickerPresence } from '../resolveMachinePickerPresence';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

type MachineSelectionListModel = Readonly<{
    rootStep: SelectionListStep;
    selectedOptionId: string | null;
}>;

export type BuildMachineSelectionListModelParams = Readonly<{
    groups: ReadonlyArray<ServerScopedMachineGroup>;
    selectedMachine: Machine | null;
    selectedServerId: string | null;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachines: ReadonlyArray<Machine>;
    onSelectMachine: (machine: Machine) => void;
    onSelectScopedMachine: (machine: ServerScopedMachine) => void;
    serverId?: string | null;
    onToggleFavorite?: (machine: Machine) => void;
    showFavorites: boolean;
    showRecent: boolean;
    showSearch: boolean;
    showCliGlyphs: boolean;
    autoDetectCliGlyphs: boolean;
    favoriteGroupPlacement?: MachineSelectionFavoriteGroupPlacement;
    testIdPrefix?: string;
}>;

function machineLabel(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id;
}

function machineSubtitle(machine: Machine): string {
    return machine.metadata?.host || machine.id;
}

function buildOptionTestID(testIdPrefix: string | undefined, machine: Machine): string | undefined {
    const normalized = typeof testIdPrefix === 'string' ? testIdPrefix.trim() : '';
    return normalized ? `${normalized}-option:${machine.id}` : undefined;
}

function buildReadinessTestID(testIdPrefix: string | undefined, machine: Machine): string | undefined {
    const normalized = typeof testIdPrefix === 'string' ? testIdPrefix.trim() : '';
    return normalized ? `${normalized}-readiness:${machine.id}` : undefined;
}

function bucketTitle(bucketId: MachineSelectionBucketId): string {
    switch (bucketId) {
        case 'recent':
            return t('newSession.machinePicker.recentTitle');
        case 'favorites':
            return t('newSession.machinePicker.favoritesTitle');
        case 'all':
            return t('newSession.machinePicker.allTitle');
    }
}

function bucketIconName(bucketId: MachineSelectionBucketId): IconName {
    return bucketId === 'recent' ? 'clock' : 'desktop';
}

export function useMachineSelectionListModel(
    params: BuildMachineSelectionListModelParams,
): MachineSelectionListModel {
    const { theme } = useUnistyles();

    // The row handlers are BEHAVIOUR, not data, so they are held in a ref and
    // invoked through stable wrappers instead of being memo dependencies.
    //
    // The machine popover builds its content through
    // `renderContent({ requestClose, maxHeight })`, which the floating overlay
    // re-invokes with fresh inline arrows on every render while the popover is
    // open (at minimum once more when the measured placement lands). With the
    // raw handlers in the dependency list, each of those passes rebuilt the
    // whole step tree — every option object plus its `icon` and
    // `rightAccessory` elements — so React lost element identity for every row
    // and re-rendered each row's Phosphor icon, readiness accessory and CLI
    // glyphs subtree instead of skipping them. Only the DATA inputs below may
    // invalidate the model; a replaced handler is picked up through the ref on
    // the next activation.
    const handlersRef = React.useRef({
        onSelectMachine: params.onSelectMachine,
        onSelectScopedMachine: params.onSelectScopedMachine,
        onToggleFavorite: params.onToggleFavorite,
    });
    React.useEffect(() => {
        handlersRef.current = {
            onSelectMachine: params.onSelectMachine,
            onSelectScopedMachine: params.onSelectScopedMachine,
            onToggleFavorite: params.onToggleFavorite,
        };
    });
    const selectMachine = React.useCallback((machine: Machine) => {
        handlersRef.current.onSelectMachine(machine);
    }, []);
    const selectScopedMachine = React.useCallback((machine: ServerScopedMachine) => {
        handlersRef.current.onSelectScopedMachine(machine);
    }, []);
    const toggleFavorite = React.useCallback((machine: Machine) => {
        handlersRef.current.onToggleFavorite?.(machine);
    }, []);
    // Presence (not identity) of the favorite handler is a real render input:
    // `MachineSelectionRowAccessory` only paints the star when it receives one.
    const favoriteToggle = typeof params.onToggleFavorite === 'function'
        ? toggleFavorite
        : undefined;

    return React.useMemo(() => {
        const inputPlaceholder = params.showSearch
            ? t('newSession.machinePicker.searchPlaceholder')
            : undefined;
        if (params.groups.length === 0) {
            return {
                selectedOptionId: null,
                rootStep: {
                    id: 'machine-root',
                    inputPlaceholder,
                    emptyStateLabel: t('newSession.noMachinesFound'),
                    sections: [],
                },
            };
        }

        if (params.groups.length === 1 && !params.groups[0]!.loading && !params.groups[0]!.signedOut) {
            const group = params.groups[0]!;
            const bucketModel = buildMachineSelectionBuckets({
                machines: group.machines,
                recentMachines: params.recentMachines,
                favoriteMachines: params.favoriteMachines,
                showFavorites: params.showFavorites,
                showRecent: params.showRecent,
                disableOfflineMachines: true,
                favoriteGroupPlacement: params.favoriteGroupPlacement,
            });

            const sections: SelectionListSectionDescriptor[] = bucketModel.buckets.map((bucket) => ({
                kind: 'static',
                id: bucket.id,
                title: bucketTitle(bucket.id),
                options: bucket.machines.map((machine) => {
                    const presence = resolveMachinePickerPresence(machine);
                    return {
                        id: machine.id,
                        testID: buildOptionTestID(params.testIdPrefix, machine),
                        label: machineLabel(machine),
                        icon: (
                            <Icon
                                name={bucketIconName(bucket.id)}
                                size={24}
                                color={theme.colors.text.secondary}
                            />
                        ),
                        disabled: !presence.selectable,
                        rightAccessory: (
                            <MachineSelectionRowAccessory
                                machine={machine}
                                serverId={params.serverId}
                                readinessTestID={buildReadinessTestID(params.testIdPrefix, machine)}
                                showCliGlyphs={params.showCliGlyphs}
                                autoDetectCliGlyphs={params.autoDetectCliGlyphs}
                                showFavoriteToggle={params.showFavorites}
                                isFavorite={bucketModel.favoriteMachineIdSet.has(machine.id)}
                                onToggleFavorite={favoriteToggle}
                            />
                        ),
                        onSelect: () => {
                            if (!resolveMachinePickerPresence(machine).selectable) return;
                            selectMachine(machine);
                        },
                    } satisfies SelectionListOption;
                }),
            }));

            return {
                selectedOptionId: params.selectedMachine?.id ?? null,
                rootStep: {
                    id: 'machine-root',
                    inputPlaceholder,
                    emptyStateLabel: t('newSession.noMachinesFound'),
                    sections,
                },
            };
        }

        const sections: SelectionListSectionDescriptor[] = params.groups.map((group) => {
            let options: SelectionListOption[];
            if (group.loading) {
                options = [{
                    id: `server:${group.serverId}:loading`,
                    label: t('common.loading'),
                    disabled: true,
                }];
            } else if (group.signedOut) {
                options = [{
                    id: `server:${group.serverId}:signed-out`,
                    label: t('server.signedOut'),
                    disabled: true,
                }];
            } else if (group.machines.length === 0) {
                options = [{
                    id: `server:${group.serverId}:empty`,
                    label: t('newSession.noMachinesFound'),
                    disabled: true,
                }];
            } else {
                options = group.machines.map((machine) => {
                    const presence = resolveMachinePickerPresence(machine);
                    return {
                        id: `${group.serverId}::${machine.id}`,
                        testID: buildOptionTestID(params.testIdPrefix, machine),
                        label: machineLabel(machine),
                        subtitle: machineSubtitle(machine),
                        icon: (
                            <Icon
                                name="desktop"
                                size={20}
                                color={theme.colors.text.secondary}
                            />
                        ),
                        disabled: !presence.selectable,
                        rightAccessory: (
                            <MachineSelectionRowAccessory
                                machine={machine}
                                serverId={group.serverId}
                                readinessTestID={buildReadinessTestID(params.testIdPrefix, machine)}
                                showCliGlyphs={false}
                                autoDetectCliGlyphs={false}
                                showFavoriteToggle={false}
                                isFavorite={false}
                            />
                        ),
                        onSelect: () => {
                            if (!resolveMachinePickerPresence(machine).selectable) return;
                            selectScopedMachine(machine);
                        },
                    } satisfies SelectionListOption;
                });
            }

            return {
                kind: 'static',
                id: `server:${group.serverId}`,
                title: group.serverName,
                count: group.machines.length,
                options,
            };
        });

        const selectedOptionId = params.selectedServerId && params.selectedMachine
            ? `${params.selectedServerId}::${params.selectedMachine.id}`
            : null;

        return {
            selectedOptionId,
            rootStep: {
                id: 'machine-root',
                inputPlaceholder,
                emptyStateLabel: t('newSession.noMachinesFound'),
                sections,
            },
        };
    }, [
        params.autoDetectCliGlyphs,
        params.favoriteGroupPlacement,
        params.favoriteMachines,
        params.groups,
        favoriteToggle,
        selectMachine,
        selectScopedMachine,
        params.recentMachines,
        params.selectedMachine,
        params.selectedServerId,
        params.serverId,
        params.showCliGlyphs,
        params.showFavorites,
        params.showRecent,
        params.showSearch,
        params.testIdPrefix,
        theme.colors.text.secondary,
    ]);
}
