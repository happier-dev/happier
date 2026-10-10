import React from 'react';
import { Pressable, type View as RNView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { SelectionList } from '@/components/ui/selectionList';
import { useMachineSelectionListModel } from './machineSelection/useMachineSelectionListModel';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { describeMachineSharedOwnership } from '@/sync/domains/machines/machineOwnershipGroups';
import { t } from '@/text';
import { resolveMachinePickerPresence } from './resolveMachinePickerPresence';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { buildMachineSelectionBuckets } from './machineSelection/buildMachineSelectionBuckets';
import type { MachineDestinationPurposeV1 } from '@happier-dev/protocol/machines/pools';
import { describeMachineDestinationEligibility, resolveMachineDestinationPurposeEligibility, type MachineDestinationPlacementFacts } from './machineSelection/buildMachineDestinationModel';
import { useMachineDestinationWorkerStatus, type MachineDestinationWorkerPlacement } from '@/components/sessions/new/hooks/machines/useMachineDestinationWorkerStatus';

const EMPTY_MACHINES: readonly Machine[] = [];

export interface MachineSelectorProps {
    purpose?: MachineDestinationPurposeV1;
    workerPlacement?: MachineDestinationWorkerPlacement;
    resolveMachinePlacementFacts?: (machine: Machine, serverId: string) => MachineDestinationPlacementFacts;
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

export function MachineSelector({
    purpose = 'session',
    workerPlacement,
    resolveMachinePlacementFacts: suppliedMachinePlacementFacts,
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
    const demandedWorkerFacts = useMachineDestinationWorkerStatus({
        purpose,
        workerPlacement: presentation === 'dropdown' ? workerPlacement : undefined,
        groups: [{ serverId: serverId ?? '', machines, loading: false, signedOut: false }],
    });
    const resolveMachinePlacementFacts = presentation === 'dropdown' && workerPlacement && (purpose === 'finite' || purpose === 'service-start')
        ? demandedWorkerFacts : suppliedMachinePlacementFacts;

    const searchPlaceholder = searchPlaceholderProp ?? t('newSession.machinePicker.searchPlaceholder');
    const recentSectionTitle = recentSectionTitleProp ?? t('newSession.machinePicker.recentTitle');
    const favoritesSectionTitle = favoritesSectionTitleProp ?? t('newSession.machinePicker.favoritesTitle');
    const allSectionTitle = allSectionTitleProp ?? t('newSession.machinePicker.allTitle');
    const noItemsMessage = noItemsMessageProp ?? t('newSession.machinePicker.emptyMessage');
    const machineOptionTestIdPrefix = typeof testIdPrefix === 'string' && testIdPrefix.trim()
        ? `${testIdPrefix.trim()}-option`
        : undefined;
    const getMachineOptionTestID = React.useCallback((machine: Machine) => {
        return machineOptionTestIdPrefix ? `${machineOptionTestIdPrefix}:${machine.id}` : undefined;
    }, [machineOptionTestIdPrefix]);
    const selectedMachineId = selectedMachine?.id ?? null;
    const bucketModel = React.useMemo(() => buildMachineSelectionBuckets({
        machines,
        recentMachines,
        favoriteMachines,
        showFavorites,
        showRecent,
        disableOfflineMachines,
        favoriteGroupPlacement,
        includeSelectedUnavailableMachineId: includeSelectedUnavailableMachine ? selectedMachineId : null,
    }), [
        disableOfflineMachines,
        favoriteGroupPlacement,
        favoriteMachines,
        includeSelectedUnavailableMachine,
        machines,
        recentMachines,
        selectedMachineId,
        showFavorites,
        showRecent,
    ]);
    const visibleMachines = bucketModel.visibleMachines;
    // One naming owner for every machine this selector shows, telling same-named machines apart.
    const machineNames = React.useMemo(() => resolveMachineDisplayNames(machines), [machines]);
    const machineName = (machine: Machine): string => machineNames.get(machine.id) ?? getMachineDisplayName(machine) ?? machine.id;
    const launchPinnedFavoriteMachines = bucketModel.favoriteMachines;
    const favoriteMachineIdSet = bucketModel.favoriteMachineIdSet;
    const visibleRecentMachinesWithoutFavorites = bucketModel.recentMachinesWithoutFavorites;
    const visibleAllMachines = bucketModel.allMachines;
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
        const eligibility = resolveMachineDestinationPurposeEligibility(purpose, resolveMachinePlacementFacts?.(machine, serverId ?? ''), machine);
        const purposeEligible = eligibility.eligible;
        const unavailable = !presence.selectable || !purposeEligible;
        return {
            id: machine.id,
            testID: getMachineOptionTestID(machine),
            title: machineName(machine),
            subtitle: [describeMachineSharedOwnership(machine), describeMachineDestinationEligibility(eligibility, machine)
                ?? (unavailable ? t('common.unavailable') : t('status.online'))].filter(Boolean).join(' · '),
            category,
            disabled: !purposeEligible || (disableOfflineMachines && unavailable),
            icon: (
                <Icon
                    name={iconName}
                    size={20}
                    color={theme.colors.text.secondary}
                />
            ),
            rightElement: renderFavoriteToggle(machine, isFavorite),
        };
    }, [disableOfflineMachines, getMachineOptionTestID, purpose, resolveMachinePlacementFacts, serverId, renderFavoriteToggle, theme.colors.text.secondary]);

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
        const allItems = bucketModel.buckets.filter((bucket) => bucket.id === 'all' || bucket.id === 'shared').flatMap((bucket) =>
            bucket.machines.map((machine) => toDropdownItem(machine, bucket.id === 'shared'
                ? t('machines.destinations.shared', { team: bucket.custodian?.displayName || t('common.unknown') })
                : allSectionTitle, favoriteMachineIdSet.has(machine.id), 'desktop')));

        return favoriteGroupPlacement === 'beforeRecent'
            ? [...favoriteItems, ...recentItems, ...allItems]
            : [...recentItems, ...favoriteItems, ...allItems];
    }, [
        allSectionTitle,
        bucketModel.buckets,
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
                        if (!resolveMachineDestinationPurposeEligibility(purpose, resolveMachinePlacementFacts?.(machine, serverId ?? ''), machine).eligible) return;
                        if (disableOfflineMachines && !resolveMachinePickerPresence(machine).selectable) return;
                        onSelect(machine);
                    }}
                    rowKind="item"
                    variant="selectable"
                    search={showSearch}
                    searchPlaceholder={searchPlaceholder}
                    showCategoryTitles={showFavorites || showRecent || visibleAllMachines.some((machine) => machine.isShared)}
                    matchTriggerWidth
                    connectToTrigger
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: dropdownTitle ?? t('newSession.selectMachineTitle'),
                        subtitle: dropdownSubtitle ?? (selectedMachine ? machineName(selectedMachine) : t('newSession.selectMachineDescription')),
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

    return <MachineSelectorList
        purpose={purpose} workerPlacement={workerPlacement} resolveMachinePlacementFacts={resolveMachinePlacementFacts}
        machines={machines} selectedMachine={selectedMachine} recentMachines={recentMachines} favoriteMachines={favoriteMachines}
        onSelect={onSelect} onToggleFavorite={onToggleFavorite} showFavorites={showFavorites} showRecent={showRecent}
        showSearch={showSearch} showCliGlyphs={showCliGlyphs} autoDetectCliGlyphs={autoDetectCliGlyphs} serverId={serverId}
        favoriteGroupPlacement={favoriteGroupPlacement} testIdPrefix={testIdPrefix} disableOfflineMachines={disableOfflineMachines}
        includeSelectedUnavailableMachine={includeSelectedUnavailableMachine} searchPlaceholder={searchPlaceholder}
        recentSectionTitle={recentSectionTitle} favoritesSectionTitle={favoritesSectionTitle} allSectionTitle={allSectionTitle}
        noItemsMessage={noItemsMessage}
    />;
}

function MachineSelectorList(props: MachineSelectorProps) {
    const groupServerId = props.serverId ?? '';
    const groups = React.useMemo(() => [{
        serverId: groupServerId, serverName: '', loading: false, signedOut: false,
        machines: props.machines.map((machine) => ({ ...machine, serverId: groupServerId, serverName: '' })),
    }], [groupServerId, props.machines]);
    const sectionTitles = React.useMemo(() => ({
        recent: props.recentSectionTitle, favorites: props.favoritesSectionTitle, all: props.allSectionTitle,
    }), [props.recentSectionTitle, props.favoritesSectionTitle, props.allSectionTitle]);
    const resolveAvailability = React.useCallback((machine: Machine) => {
        const presence = resolveMachinePickerPresence(machine);
        return { selectable: presence.selectable || (props.disableOfflineMachines === false && presence.status === 'offline') };
    }, [props.disableOfflineMachines]);
    const selectMachine = React.useCallback((machine: Machine) => {
        const original = props.machines.find((candidate) => candidate.id === machine.id);
        if (original) props.onSelect(original);
    }, [props.machines, props.onSelect]);
    const toggleFavorite = React.useCallback((machine: Machine) => {
        const original = props.machines.find((candidate) => candidate.id === machine.id);
        if (original) props.onToggleFavorite?.(original);
    }, [props.machines, props.onToggleFavorite]);
    const model = useMachineSelectionListModel({
        purpose: props.purpose ?? 'session', workerPlacement: props.workerPlacement, resolveMachinePlacementFacts: props.resolveMachinePlacementFacts,
        groups, selectedMachine: props.selectedMachine, selectedServerId: groupServerId,
        recentMachines: props.recentMachines ?? EMPTY_MACHINES, favoriteMachines: props.favoriteMachines ?? EMPTY_MACHINES,
        onSelectMachine: selectMachine, onSelectScopedMachine: selectMachine,
        onToggleFavorite: props.onToggleFavorite ? toggleFavorite : undefined,
        showFavorites: props.showFavorites ?? true, showRecent: props.showRecent ?? true, showSearch: props.showSearch ?? true,
        showCliGlyphs: props.showCliGlyphs ?? true, autoDetectCliGlyphs: props.autoDetectCliGlyphs ?? true,
        serverId: props.serverId, favoriteGroupPlacement: props.favoriteGroupPlacement, testIdPrefix: props.testIdPrefix,
        disableOfflineMachines: props.disableOfflineMachines, resolveMachineAvailability: resolveAvailability,
        includeSelectedUnavailableMachineId: props.includeSelectedUnavailableMachine ? props.selectedMachine?.id : null,
        searchPlaceholder: props.searchPlaceholder, emptyStateLabel: props.noItemsMessage, sectionTitles,
    });
    return <SelectionList testID={props.testIdPrefix ? `${props.testIdPrefix}-list` : 'machine-selector-list'}
        rootStep={model.rootStep} selectedOptionId={model.selectedOptionId} onSelect={() => {}} onRequestClose={() => {}} />;
}
