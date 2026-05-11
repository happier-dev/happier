import React from 'react';
import { Pressable, type View as RNView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { SearchableListSelector } from '@/components/ui/forms/SearchableListSelector';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';

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
    dropdownTitle?: string;
    dropdownSubtitle?: string | null;
    dropdownTestID?: string;
    popoverBoundaryRef?: React.RefObject<RNView> | null;
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

    const visibleMachines = React.useMemo(() => machines.filter((machine) => !machine.revokedAt), [machines]);
    const visibleRecentMachines = React.useMemo(
        () => recentMachines.filter((machine) => !machine.revokedAt),
        [recentMachines],
    );
    const visibleFavoriteMachines = React.useMemo(
        () => favoriteMachines.filter((machine) => !machine.revokedAt),
        [favoriteMachines],
    );
    const favoriteMachineIdSet = React.useMemo(() => {
        if (!showFavorites) return new Set<string>();
        return new Set<string>(visibleFavoriteMachines.map((machine) => machine.id));
    }, [showFavorites, visibleFavoriteMachines]);
    const visibleRecentMachinesWithoutFavorites = React.useMemo(() => {
        if (!showRecent) return visibleRecentMachines;
        if (favoriteMachineIdSet.size === 0) return visibleRecentMachines;
        return visibleRecentMachines.filter((machine) => !favoriteMachineIdSet.has(machine.id));
    }, [favoriteMachineIdSet, showRecent, visibleRecentMachines]);
    const visibleAllMachines = React.useMemo(() => {
        const pinnedIds = new Set<string>();
        if (showFavorites) for (const machine of visibleFavoriteMachines) pinnedIds.add(machine.id);
        if (showRecent) for (const machine of visibleRecentMachinesWithoutFavorites) pinnedIds.add(machine.id);
        if (pinnedIds.size === 0) return visibleMachines;
        return visibleMachines.filter((machine) => !pinnedIds.has(machine.id));
    }, [showFavorites, showRecent, visibleFavoriteMachines, visibleMachines, visibleRecentMachinesWithoutFavorites]);
    const selectedMachineId = selectedMachine?.id ?? null;
    const machineById = React.useMemo(() => {
        return new Map([
            ...visibleMachines,
            ...visibleRecentMachines,
            ...visibleFavoriteMachines,
        ].map((machine) => [machine.id, machine] as const));
    }, [visibleFavoriteMachines, visibleMachines, visibleRecentMachines]);

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
                <Ionicons
                    name={isFavorite ? 'star' : 'star-outline'}
                    size={22}
                    color={isFavorite ? selectedColor : theme.colors.text.secondary}
                />
            </Pressable>
        );
    }, [onToggleFavorite, showFavorites, theme.colors.button.primary.background, theme.colors.text.secondary]);

    const toDropdownItem = React.useCallback((
        machine: Machine,
        category: string,
        isFavorite: boolean,
        iconName: React.ComponentProps<typeof Ionicons>['name'],
    ): DropdownMenuItem => {
        const offline = !isMachineOnline(machine);
        return {
            id: machine.id,
            title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
            subtitle: offline ? t('status.offline') : t('status.online'),
            category,
            disabled: disableOfflineMachines && offline,
            icon: (
                <Ionicons
                    name={iconName}
                    size={20}
                    color={theme.colors.text.secondary}
                />
            ),
            rightElement: renderFavoriteToggle(machine, isFavorite),
        };
    }, [disableOfflineMachines, renderFavoriteToggle, theme.colors.text.secondary]);

    const dropdownItems = React.useMemo(() => {
        const favoriteItems = showFavorites
            ? visibleFavoriteMachines.map((machine) => toDropdownItem(
                machine,
                favoritesSectionTitle,
                true,
                'desktop-outline',
            ))
            : [];
        const recentItems = showRecent
            ? visibleRecentMachinesWithoutFavorites.map((machine) => toDropdownItem(
                machine,
                recentSectionTitle,
                favoriteMachineIdSet.has(machine.id),
                'time-outline',
            ))
            : [];
        const allItems = visibleAllMachines.map((machine) => toDropdownItem(
            machine,
            allSectionTitle,
            favoriteMachineIdSet.has(machine.id),
            'desktop-outline',
        ));

        return favoriteGroupPlacement === 'beforeRecent'
            ? [...favoriteItems, ...recentItems, ...allItems]
            : [...recentItems, ...favoriteItems, ...allItems];
    }, [
        allSectionTitle,
        favoriteGroupPlacement,
        favoriteMachineIdSet,
        favoritesSectionTitle,
        recentSectionTitle,
        showFavorites,
        showRecent,
        toDropdownItem,
        visibleAllMachines,
        visibleFavoriteMachines,
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
                        if (disableOfflineMachines && !isMachineOnline(machine)) return;
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
                            <Ionicons
                                name="desktop-outline"
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
                    <Ionicons
                        name="desktop-outline"
                        size={24}
                        color={theme.colors.text.secondary}
                    />
                ),
                getRecentItemIcon: () => (
                    <Ionicons
                        name="time-outline"
                        size={24}
                        color={theme.colors.text.secondary}
                    />
                ),
                getItemStatus: (machine) => {
                    const offline = !isMachineOnline(machine);
                    return {
                        text: offline ? t('status.offline') : t('status.online'),
                        color: offline ? theme.colors.status.disconnected : theme.colors.status.connected,
                        dotColor: offline ? theme.colors.status.disconnected : theme.colors.status.connected,
                        isPulsing: !offline,
                    };
                },
                isItemDisabled: disableOfflineMachines ? (machine) => !isMachineOnline(machine) : undefined,
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
            favoriteItems={visibleFavoriteMachines}
            selectedItem={selectedMachine}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
            searchPlacement={searchPlacement}
            groupOrder={favoriteGroupPlacement === 'beforeRecent' ? 'favoritesFirst' : 'recentFirst'}
            testIdPrefix={testIdPrefix}
        />
    );
}
