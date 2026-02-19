import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { SearchableListSelector } from '@/components/ui/forms/SearchableListSelector';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import { MachineCliGlyphs } from '@/components/sessions/new/components/MachineCliGlyphs';

export interface MachineSelectorProps {
    machines: Machine[];
    selectedMachine: Machine | null;
    recentMachines?: Machine[];
    favoriteMachines?: Machine[];
    onSelect: (machine: Machine) => void;
    onToggleFavorite?: (machine: Machine) => void;
    showFavorites?: boolean;
    showRecent?: boolean;
    showSearch?: boolean;
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
    searchPlaceholder?: string;
    recentSectionTitle?: string;
    favoritesSectionTitle?: string;
    allSectionTitle?: string;
    noItemsMessage?: string;
    /**
     * When true, offline machines are visible but non-selectable (greyed out + not-allowed cursor on web).
     */
    disableOfflineMachines?: boolean;
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
    showCliGlyphs = true,
    autoDetectCliGlyphs = true,
    serverId,
    searchPlacement = 'header',
    searchPlaceholder: searchPlaceholderProp,
    recentSectionTitle: recentSectionTitleProp,
    favoritesSectionTitle: favoritesSectionTitleProp,
    allSectionTitle: allSectionTitleProp,
    noItemsMessage: noItemsMessageProp,
    disableOfflineMachines = true,
}: MachineSelectorProps) {
    const { theme } = useUnistyles();

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
                        color={theme.colors.textSecondary}
                    />
                ),
                getRecentItemIcon: () => (
                    <Ionicons
                        name="time-outline"
                        size={24}
                        color={theme.colors.textSecondary}
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
            items={visibleMachines}
            recentItems={visibleRecentMachines}
            favoriteItems={visibleFavoriteMachines}
            selectedItem={selectedMachine}
            onSelect={onSelect}
            onToggleFavorite={onToggleFavorite}
            searchPlacement={searchPlacement}
        />
    );
}
