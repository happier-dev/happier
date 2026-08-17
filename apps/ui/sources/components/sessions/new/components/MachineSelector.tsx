import React from 'react';
import { Pressable, type View as RNView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { SearchableListSelector } from '@/components/ui/forms/SearchableListSelector';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveMachinePickerPresence } from './resolveMachinePickerPresence';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

export interface MachineSelectorProps {
    machines: ReadonlyArray<Machine>;
    selectedMachine: Machine | null;
    recentMachines?: ReadonlyArray<Machine>;
    favoriteMachines?: ReadonlyArray<Machine>;
    onSelect: (machine: Machine) => void;
    onToggleFavorite?: (machine: Machine) => void;
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;
    presentation?: 'list' | 'dropdown';
    /**
     * When true, show small CLI glyphs per machine row.
     *
     * NOTE: This can be expensive on iOS because each glyph can trigger CLI detection
     * work; keep this off in high-interaction contexts like the new session wizard.
     */
    showCliGlyphs?: boolean;
    /**
     * When false, glyphs will render from cache only and will not auto-trigger detection.
     * You can still refresh from the Detected CLIs modal by tapping the glyphs.
     */
    autoDetectCliGlyphs?: boolean;
    serverId?: string | null;
    searchPlacement?: 'header' | 'recent' | 'favorites' | 'all';
    favoriteGroupPlacement?: 'beforeRecent' | 'afterRecent';
    searchPlaceholder?: string;
    recentSectionTitle?: string;
    favoritesSectionTitle?: string;
    allSectionTitle?: string;
    noItemsMessage?: string;
    testIdPrefix?: string;
    /**
     * When true, offline machines are visible but non-selectable (greyed out + not-allowed cursor on web).
     */
    disableOfflineMachines?: boolean;
    /**
     * Keeps the selected revoked or replaced machine visible as a disabled row.
     * New-session callers keep the default false; administration surfaces opt in
     * so a persisted target does not disappear while unavailable.
     */
    includeSelectedUnavailableMachine?: boolean;
    dropdownTitle?: string;
    dropdownSubtitle?: string | null;
    dropdownTestID?: string;
    popoverBoundaryRef?: React.RefObject<RNView> | null;
}

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

export function MachineSelector({
    machines,
    selectedMachine,
    recentMachines = [],
    favoriteMachines = [],
    onSelect,
    onToggleFavorite,
    showFavorites = true,
    showRecent = true,
    showSearch = true,
    presentation = 'list',
    showCliGlyphs = true,
    autoDetectCliGlyphs = true,
    serverId,
    searchPlacement = 'header',
    favoriteGroupPlacement = 'afterRecent',
    searchPlaceholder: searchPlaceholderProp,
    recentSectionTitle: recentSectionTitleProp,
    favoritesSectionTitle: favoritesSectionTitleProp,
    allSectionTitle: allSectionTitleProp,
    noItemsMessage: noItemsMessageProp,
    testIdPrefix,
    disableOfflineMachines = true,
    includeSelectedUnavailableMachine = false,
    dropdownTitle,
    dropdownSubtitle,
    dropdownTestID,
    popoverBoundaryRef,
}: MachineSelectorProps) {
    const { theme } = useUnistyles();
    const [dropdownOpen, setDropdownOpen] = React.useState(false);

    const searchPlaceholder = searchPlaceholderProp ?? t('newSession.machinePicker.searchPlaceholder');
    const recentSectionTitle = recentSectionTitleProp ?? t('newSession.machinePicker.recentTitle');
    const favoritesSectionTitle = favoritesSectionTitleProp ?? t('newSession.machinePicker.favoritesTitle');
    const allSectionTitle = allSectionTitleProp ?? t('newSession.machinePicker.allTitle');
    const noItemsMessage = noItemsMessageProp ?? t('newSession.machinePicker.emptyMessage');
    const machineOptionTestIdPrefix = typeof testIdPrefix === 'string' && testIdPrefix.trim()
        ? `${testIdPrefix.trim()}-option`
        : undefined;
    const machineReadinessTestIdPrefix = typeof testIdPrefix === 'string' && testIdPrefix.trim()
        ? `${testIdPrefix.trim()}-readiness`
        : undefined;
    const getMachineOptionTestID = React.useCallback((machine: Machine) => {
        return machineOptionTestIdPrefix ? `${machineOptionTestIdPrefix}:${machine.id}` : undefined;
    }, [machineOptionTestIdPrefix]);
    const getMachineReadinessTestID = React.useCallback((machine: Machine) => {
        return machineReadinessTestIdPrefix ? `${machineReadinessTestIdPrefix}:${machine.id}` : undefined;
    }, [machineReadinessTestIdPrefix]);
    const selectedMachineId = selectedMachine?.id ?? null;
    const isVisibleForPicker = React.useCallback((machine: Machine) => {
        return isMachineVisibleForLaunchSelection(machine)
            || (includeSelectedUnavailableMachine && machine.id === selectedMachineId);
    }, [includeSelectedUnavailableMachine, selectedMachineId]);

    const visibleMachines = React.useMemo(
        () => machines.filter(isVisibleForPicker),
        [isVisibleForPicker, machines],
    );
    const visibleRecentMachines = React.useMemo(
        () => recentMachines.filter(isVisibleForPicker),
        [isVisibleForPicker, recentMachines],
    );
    const visibleFavoriteMachines = React.useMemo(
        () => favoriteMachines.filter(isVisibleForPicker),
        [favoriteMachines, isVisibleForPicker],
    );
    const launchPinnedRecentMachines = React.useMemo(
        () => disableOfflineMachines
            ? visibleRecentMachines.filter(isMachineSelectableForLaunch)
            : visibleRecentMachines,
        [disableOfflineMachines, visibleRecentMachines],
    );
    const launchPinnedFavoriteMachines = React.useMemo(
        () => disableOfflineMachines
            ? visibleFavoriteMachines.filter(isMachineSelectableForLaunch)
            : visibleFavoriteMachines,
        [disableOfflineMachines, visibleFavoriteMachines],
    );
    const favoriteMachineIdSet = React.useMemo(() => {
        if (!showFavorites) return new Set<string>();
        return new Set<string>(launchPinnedFavoriteMachines.map((machine) => machine.id));
    }, [launchPinnedFavoriteMachines, showFavorites]);
    const visibleRecentMachinesWithoutFavorites = React.useMemo(() => {
        if (!showRecent) return launchPinnedRecentMachines;
        if (favoriteMachineIdSet.size === 0) return launchPinnedRecentMachines;
        return launchPinnedRecentMachines.filter((machine) => !favoriteMachineIdSet.has(machine.id));
    }, [favoriteMachineIdSet, launchPinnedRecentMachines, showRecent]);
    const visibleAllMachines = React.useMemo(() => {
        const pinnedIds = new Set<string>();
        if (showFavorites) for (const machine of launchPinnedFavoriteMachines) pinnedIds.add(machine.id);
        if (showRecent) for (const machine of visibleRecentMachinesWithoutFavorites) pinnedIds.add(machine.id);
        const unpinnedMachines = pinnedIds.size === 0
            ? visibleMachines
            : visibleMachines.filter((machine) => !pinnedIds.has(machine.id));
        return disableOfflineMachines
            ? prioritizeSelectableMachines(unpinnedMachines)
            : unpinnedMachines;
    }, [
        disableOfflineMachines,
        launchPinnedFavoriteMachines,
        showFavorites,
        showRecent,
        visibleMachines,
        visibleRecentMachinesWithoutFavorites,
    ]);
    const machineById = React.useMemo(() => {
        return new Map([
            ...visibleMachines,
            ...visibleRecentMachinesWithoutFavorites,
            ...launchPinnedFavoriteMachines,
        ].map((machine) => [machine.id, machine] as const));
    }, [launchPinnedFavoriteMachines, visibleMachines, visibleRecentMachinesWithoutFavorites]);

    const renderFavoriteToggle = React.useCallback((machine: Machine, isFavorite: boolean) => {
        if (!showFavorites || !onToggleFavorite) return null;

        const selectedColor = theme.colors.button.primary.background;
        return (
            <Pressable
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                onPress={(event) => {
                    event.stopPropagation?.();
                    onToggleFavorite(machine);
                }}
            >
                <Icon
                    name="star"
                    size={20}
                    color={isFavorite ? selectedColor : theme.colors.text.secondary}
                    weight={isFavorite ? 'fill' : 'regular'}
                />
            </Pressable>
        );
    }, [onToggleFavorite, showFavorites, theme.colors.button.primary.background, theme.colors.text.secondary]);

    const toDropdownItem = React.useCallback((
        machine: Machine,
        category: string,
        isFavorite: boolean,
        iconName: IconName,
    ): DropdownMenuItem => {
        const presence = resolveMachinePickerPresence(machine);
        const unavailable = !presence.selectable;
        return {
            id: machine.id,
            testID: getMachineOptionTestID(machine),
            title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            subtitle: unavailable ? t('common.unavailable') : t('status.online'),
            category,
            disabled: disableOfflineMachines && unavailable,
            icon: (
                <Icon
                    name={iconName}
                    size={20}
                    color={theme.colors.text.secondary}
                />
            ),
            rightElement: renderFavoriteToggle(machine, isFavorite),
        };
    }, [disableOfflineMachines, getMachineOptionTestID, renderFavoriteToggle, theme.colors.text.secondary]);

    const dropdownItems = React.useMemo(() => {
        const favoriteItems = showFavorites
            ? launchPinnedFavoriteMachines.map((machine) => toDropdownItem(
                machine,
                favoritesSectionTitle,
                true,
                'desktop',
            ))
            : [];
        const recentItems = showRecent
            ? visibleRecentMachinesWithoutFavorites.map((machine) => toDropdownItem(
                machine,
                recentSectionTitle,
                favoriteMachineIdSet.has(machine.id),
                'clock',
            ))
            : [];
        const allItems = visibleAllMachines.map((machine) => toDropdownItem(
            machine,
            allSectionTitle,
            favoriteMachineIdSet.has(machine.id),
            'desktop',
        ));

        return favoriteGroupPlacement === 'beforeRecent'
            ? [...favoriteItems, ...recentItems, ...allItems]
            : [...recentItems, ...favoriteItems, ...allItems];
    }, [
        allSectionTitle,
        favoriteGroupPlacement,
        favoriteMachineIdSet,
        favoritesSectionTitle,
        launchPinnedFavoriteMachines,
        recentSectionTitle,
        showFavorites,
        showRecent,
        toDropdownItem,
        visibleAllMachines,
        visibleRecentMachinesWithoutFavorites,
    ]);

    if (presentation === 'dropdown') {
        return (
            <ItemGroup title="">
                <DropdownMenu
                    open={dropdownOpen}
                    onOpenChange={setDropdownOpen}
                    items={dropdownItems}
                    selectedId={selectedMachineId}
                    onSelect={(machineId) => {
                        const machine = machineById.get(machineId);
                        if (!machine) return;
                        if (disableOfflineMachines && !resolveMachinePickerPresence(machine).selectable) return;
                        onSelect(machine);
                    }}
                    rowKind="item"
                    variant="selectable"
                    search={showSearch}
                    searchPlaceholder={searchPlaceholder}
                    showCategoryTitles={showFavorites || showRecent}
                    matchTriggerWidth
                    connectToTrigger
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: dropdownTitle ?? t('newSession.selectMachineTitle'),
                        subtitle: dropdownSubtitle ?? selectedMachine?.metadata?.displayName ?? selectedMachine?.metadata?.host ?? selectedMachine?.id ?? t('newSession.selectMachineDescription'),
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                        icon: (
                            <Icon
                                name="desktop"
                                size={24}
                                color={theme.colors.text.secondary}
                            />
                        ),
                        itemProps: { testID: dropdownTestID },
                    }}
                />
            </ItemGroup>
        );
    }

    return (
        <SearchableListSelector<Machine>
            config={{
                getItemId: (machine) => machine.id,
                getItemTitle: (machine) => machine.metadata?.displayName || machine.metadata?.host || machine.id,
                getItemSubtitle: undefined,
                getItemIcon: () => (
                    <Icon
                        name="desktop"
                        size={24}
                        color={theme.colors.text.secondary}
                    />
                ),
                getRecentItemIcon: () => (
                    <Icon
                        name="clock"
                        size={24}
                        color={theme.colors.text.secondary}
                    />
                ),
                getItemStatus: (machine) => {
                    const presence = resolveMachinePickerPresence(machine);
                    const offline = !presence.selectable;
                    const testID = getMachineReadinessTestID(machine);
                    return {
                        text: offline ? t('status.offline') : t('status.online'),
                        color: offline ? theme.colors.status.disconnected : theme.colors.status.connected,
                        dotColor: offline ? theme.colors.status.disconnected : theme.colors.status.connected,
                        isPulsing: !offline,
                        state: presence.selectable ? 'ready' : presence.status,
                        testID,
                    };
                },
                getItemStatusTestID: getMachineReadinessTestID,
                isItemDisabled: disableOfflineMachines
                    ? (machine) => !resolveMachinePickerPresence(machine).selectable
                    : undefined,
                ...(showCliGlyphs ? {
                    getItemStatusExtra: (machine: Machine) => (
                        <MachineCliGlyphs
                            machineId={machine.id}
                            serverId={serverId}
                            isOnline={isMachineOnline(machine)}
                            autoDetect={autoDetectCliGlyphs}
                        />
                    ),
                } : {}),
                formatForDisplay: (machine) => machine.metadata?.displayName || machine.metadata?.host || machine.id,
                parseFromDisplay: (text) => {
                    return visibleMachines.find(m =>
                        m.metadata?.displayName === text || m.metadata?.host === text || m.id === text
                    ) || null;
                },
                filterItem: (machine, searchText) => {
                    const displayName = (machine.metadata?.displayName || '').toLowerCase();
                    const host = (machine.metadata?.host || '').toLowerCase();
                    const id = machine.id.toLowerCase();
                    const search = searchText.toLowerCase();
                    return displayName.includes(search) || host.includes(search) || id.includes(search);
                },
                searchPlaceholder,
                recentSectionTitle,
                favoritesSectionTitle,
                allSectionTitle,
                noItemsMessage,
                showFavorites,
                showRecent,
                showSearch,
                allowCustomInput: false,
            }}
            items={visibleAllMachines}
            recentItems={visibleRecentMachinesWithoutFavorites}
            favoriteItems={launchPinnedFavoriteMachines}
            selectedItem={selectedMachine}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
            searchPlacement={searchPlacement}
            groupOrder={favoriteGroupPlacement === 'beforeRecent' ? 'favoritesFirst' : 'recentFirst'}
            testIdPrefix={machineOptionTestIdPrefix}
        />
    );
}
