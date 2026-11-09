import React from 'react';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { type View as RNView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { SelectionList } from '@/components/ui/selectionList';
import { supportsManagedMachineSelection, useMachineSelectionListModel } from './machineSelection/useMachineSelectionListModel';
import type { ManagedMachineSelectionOffer } from './machineSelection/managedMachineSelection';
import type { ManagedSessionPlacementV1 } from '@happier-dev/protocol/teams/managedDefaults';
import { foldOfflineWorkers } from './machineSelection/foldOfflineWorkers';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { describeMachineSharedOwnership } from '@/sync/domains/machines/machineOwnershipGroups';
import { t } from '@/text';
import { resolveMachinePickerPresence } from './resolveMachinePickerPresence';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { buildMachineSelectionBuckets } from './machineSelection/buildMachineSelectionBuckets';
import type { MachineDestinationPurposeV1 } from '@happier-dev/protocol/machines/pools';
import { describeMachineDestinationEligibility, describeMachineDestinationWorkerFacts, resolveMachineDestinationPurposeEligibility, type MachineDestinationPlacementFacts } from './machineSelection/buildMachineDestinationModel';
import { useMachineDestinationWorkerStatus, type MachineDestinationWorkerPlacement } from '@/components/sessions/new/hooks/machines/useMachineDestinationWorkerStatus';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

const EMPTY_MACHINES: readonly Machine[] = [];
const EMPTY_MANAGED_MACHINES: readonly ManagedMachineSelectionOffer[] = [];
/** The dropdown row that chooses no machine (a trimmed id, so the page field can show it). */
const CLEAR_OPTION_ID = '__none__';

export interface MachineSelectorProps {
    purpose?: MachineDestinationPurposeV1;
    workerPlacement?: MachineDestinationWorkerPlacement;
    resolveMachinePlacementFacts?: (machine: Machine, serverId: string) => MachineDestinationPlacementFacts;
    machines: ReadonlyArray<Machine>;
    selectedMachine: Machine | null;
    managedMachines?: readonly ManagedMachineSelectionOffer[];
    managedPlacementPreset?: Extract<ManagedSessionPlacementV1, { kind: 'preset' }> | null;
    onDropdownOpenChange?: (open: boolean) => void;
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
    currentUiContextCommandScope?: string;
    currentUiContextForegroundOverlay?: boolean;
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
    /** A short fact about one machine ("This machine"), shown in the dropdown row's subtitle. */
    describeMachine?: (machine: Machine) => string | null;
    dropdownTitle?: string;
    dropdownSubtitle?: string | null;
    dropdownTestID?: string;
    popoverBoundaryRef?: React.RefObject<RNView> | null;
    /**
     * An optional destination (a default, not a launch): the dropdown leads with this row,
     * which chooses no machine. Its title is also the trigger's answer while nothing is chosen.
     */
    dropdownClearOption?: Readonly<{
        title: string;
        subtitle?: string;
        /** Nothing is chosen, so this row is the current answer (false while a choice the list can't show stands). */
        current: boolean;
        onSelect: () => void;
    }>;
    /** The dropdown row sits inside the caller's own section instead of a section of its own. */
    dropdownInCallerSection?: boolean;
}

export function MachineSelector({
    purpose = 'session',
    workerPlacement,
    resolveMachinePlacementFacts: suppliedMachinePlacementFacts,
    machines,
    selectedMachine,
    managedMachines = EMPTY_MANAGED_MACHINES,
    managedPlacementPreset,
    onDropdownOpenChange,
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
    currentUiContextCommandScope,
    currentUiContextForegroundOverlay,
    disableOfflineMachines = true,
    includeSelectedUnavailableMachine = false,
    describeMachine,
    dropdownTitle,
    dropdownSubtitle,
    dropdownTestID,
    popoverBoundaryRef,
    dropdownClearOption,
    dropdownInCallerSection = false,
}: MachineSelectorProps) {
    const { theme } = useUnistyles();
    const reachabilityRevision = useMachineReachabilityRevision();
    const { binding } = useServerCredentialAccountScopeBinding(serverId ?? getAppliedActiveServerSnapshot().serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const [dropdownOpen, setDropdownOpen] = React.useState(false);
    const changeDropdownOpen = React.useCallback((open: boolean) => {
        setDropdownOpen(open);
        onDropdownOpenChange?.(open);
    }, [onDropdownOpenChange]);
    const managedOffers = supportsManagedMachineSelection(purpose) ? managedMachines : EMPTY_MANAGED_MACHINES;
    const selectedManagedOffer = managedPlacementPreset ? managedOffers.find(offer =>
        offer.homeId === managedPlacementPreset.homeId && offer.presetId === managedPlacementPreset.presetId) : undefined;
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
        scope,
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
        serverId,
        reachabilityRevision,
        scope,
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
            <HappierPressable
                hitReach={0}
                onPress={(event) => {
                    event?.stopPropagation?.();
                    onToggleFavorite(machine);
                }}
            >
                <Icon
                    name="star"
                    size={20}
                    color={isFavorite ? selectedColor : theme.colors.text.secondary}
                    weight={isFavorite ? 'fill' : 'regular'}
                />
            </HappierPressable>
        );
    }, [onToggleFavorite, showFavorites, theme.colors.button.primary.background, theme.colors.text.secondary]);

    const toDropdownItem = React.useCallback((
        machine: Machine,
        category: string,
        isFavorite: boolean,
        iconName: IconName,
    ): DropdownMenuItem => {
        const presence = resolveMachinePickerPresence(machine, undefined, scope);
        const eligibility = resolveMachineDestinationPurposeEligibility(purpose, resolveMachinePlacementFacts?.(machine, serverId ?? ''), machine, scope);
        const purposeEligible = eligibility.eligible;
        const unavailable = !purposeEligible || (!eligibility.managedWake && !presence.selectable);
        return {
            id: machine.id,
            testID: getMachineOptionTestID(machine),
            title: machineName(machine),
            subtitle: [describeMachine?.(machine), describeMachineSharedOwnership(machine), describeMachineDestinationEligibility(eligibility, machine)
                ?? describeMachineDestinationWorkerFacts(eligibility, undefined, purpose, machineName(machine))
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
    }, [describeMachine, disableOfflineMachines, getMachineOptionTestID, purpose, reachabilityRevision, resolveMachinePlacementFacts, serverId, scope, renderFavoriteToggle, theme.colors.text.secondary]);

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

        const machineItems = favoriteGroupPlacement === 'beforeRecent'
            ? [...favoriteItems, ...recentItems, ...allItems]
            : [...recentItems, ...favoriteItems, ...allItems];
        return [...machineItems, ...managedOffers.map(offer => ({
            id: offer.id,
            title: offer.title,
            subtitle: [offer.subtitle, offer.unavailableText].filter(Boolean).join(' ') || undefined,
            icon: offer.mark,
            disabled: offer.disabled,
        }))];
    }, [
        allSectionTitle,
        bucketModel.buckets,
        favoriteGroupPlacement,
        favoriteMachineIdSet,
        favoritesSectionTitle,
        launchPinnedFavoriteMachines,
        managedOffers,
        recentSectionTitle,
        showFavorites,
        showRecent,
        toDropdownItem,
        visibleAllMachines,
        visibleRecentMachinesWithoutFavorites,
    ]);

    if (presentation === 'dropdown') {
        const dropdown = (
                <DropdownMenu
                    open={dropdownOpen}
                    onOpenChange={changeDropdownOpen}
                    items={dropdownClearOption
                        ? [{ id: CLEAR_OPTION_ID, title: dropdownClearOption.title, subtitle: dropdownClearOption.subtitle }, ...dropdownItems]
                        : dropdownItems}
                    selectedId={selectedMachineId ?? selectedManagedOffer?.id ?? (dropdownClearOption?.current ? CLEAR_OPTION_ID : null)}
                    onSelect={(machineId) => {
                        if (dropdownClearOption && machineId === CLEAR_OPTION_ID) {
                            dropdownClearOption.onSelect();
                            return;
                        }
                        const managed = managedOffers.find(offer => offer.id === machineId);
                        if (managed) {
                            if (!managed.disabled) managed.onSelect?.();
                            return;
                        }
                        const machine = machineById.get(machineId);
                        if (!machine) return;
                        const eligibility = resolveMachineDestinationPurposeEligibility(purpose, resolveMachinePlacementFacts?.(machine, serverId ?? ''), machine, scope);
                        if (!eligibility.eligible) return;
                        if (disableOfflineMachines && !eligibility.managedWake && !resolveMachinePickerPresence(machine, undefined, scope).selectable) return;
                        onSelect(machine);
                    }}
                    rowKind="item"
                    variant="selectable"
                    search={showSearch}
                    searchPlaceholder={searchPlaceholder}
                    emptyLabel={noItemsMessage}
                    showCategoryTitles={showFavorites || showRecent || visibleAllMachines.some((machine) => machine.isShared)}
                    matchTriggerWidth
                    connectToTrigger
                    popoverBoundaryRef={popoverBoundaryRef}
                    itemTrigger={{
                        title: dropdownTitle ?? t('newSession.selectMachineTitle'),
                        subtitle: dropdownSubtitle ?? (selectedMachine
                            ? machineName(selectedMachine)
                            : selectedManagedOffer?.title ?? dropdownClearOption?.title ?? t('newSession.selectMachineDescription')),
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
        );
        return dropdownInCallerSection ? dropdown : <ItemGroup title="">{dropdown}</ItemGroup>;
    }

    return <MachineSelectorList
        purpose={purpose} workerPlacement={workerPlacement} resolveMachinePlacementFacts={resolveMachinePlacementFacts}
        machines={machines} selectedMachine={selectedMachine} recentMachines={recentMachines} favoriteMachines={favoriteMachines}
        managedMachines={managedMachines} managedPlacementPreset={managedPlacementPreset}
        onSelect={onSelect} onToggleFavorite={onToggleFavorite} showFavorites={showFavorites} showRecent={showRecent}
        showSearch={showSearch} showCliGlyphs={showCliGlyphs} autoDetectCliGlyphs={autoDetectCliGlyphs} serverId={serverId}
        favoriteGroupPlacement={favoriteGroupPlacement} testIdPrefix={testIdPrefix} disableOfflineMachines={disableOfflineMachines}
        currentUiContextCommandScope={currentUiContextCommandScope}
        currentUiContextForegroundOverlay={currentUiContextForegroundOverlay}
        includeSelectedUnavailableMachine={includeSelectedUnavailableMachine} searchPlaceholder={searchPlaceholder}
        recentSectionTitle={recentSectionTitle} favoritesSectionTitle={favoritesSectionTitle} allSectionTitle={allSectionTitle}
        noItemsMessage={noItemsMessage}
    />;
}

function MachineSelectorList(props: MachineSelectorProps) {
    const { theme } = useUnistyles();
    const [offlineOpen, setOfflineOpen] = React.useState(false);
    const groupServerId = props.serverId ?? getAppliedActiveServerSnapshot().serverId;
    const { binding } = useServerCredentialAccountScopeBinding(groupServerId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const groups = React.useMemo(() => [{
        serverId: groupServerId, serverName: '', loading: false, signedOut: false,
        machines: props.machines.map((machine) => ({ ...machine, serverId: groupServerId, serverName: '' })),
    }], [groupServerId, props.machines]);
    const sectionTitles = React.useMemo(() => ({
        recent: props.recentSectionTitle, favorites: props.favoritesSectionTitle, all: props.allSectionTitle,
    }), [props.recentSectionTitle, props.favoritesSectionTitle, props.allSectionTitle]);
    const resolveAvailability = React.useCallback((machine: Machine) => {
        const presence = resolveMachinePickerPresence(machine, undefined, scope);
        return { selectable: presence.selectable || (props.disableOfflineMachines === false && presence.status === 'offline') };
    }, [props.disableOfflineMachines, scope]);
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
        managedMachines: props.managedMachines, managedPlacementPreset: props.managedPlacementPreset,
        recentMachines: props.recentMachines ?? EMPTY_MACHINES, favoriteMachines: props.favoriteMachines ?? EMPTY_MACHINES,
        onSelectMachine: selectMachine, onSelectScopedMachine: selectMachine,
        onToggleFavorite: props.onToggleFavorite ? toggleFavorite : undefined,
        showFavorites: props.showFavorites ?? true, showRecent: props.showRecent ?? true, showSearch: props.showSearch ?? true,
        showCliGlyphs: props.showCliGlyphs ?? true, autoDetectCliGlyphs: props.autoDetectCliGlyphs ?? true,
        serverId: props.serverId, favoriteGroupPlacement: props.favoriteGroupPlacement, testIdPrefix: props.testIdPrefix,
        disableOfflineMachines: props.disableOfflineMachines,
        resolveMachineAvailability: props.disableOfflineMachines === false ? resolveAvailability : undefined,
        includeSelectedUnavailableMachineId: props.includeSelectedUnavailableMachine ? props.selectedMachine?.id : null,
        searchPlaceholder: props.searchPlaceholder, emptyStateLabel: props.noItemsMessage, sectionTitles,
    });
    const rootStep = React.useMemo(() => {
        const offlineIds = new Set(model.offlineOnlyMachineIdsByServerId[groupServerId] ?? []);
        return { ...model.rootStep, sections: foldOfflineWorkers(model.rootStep.sections,
            option => option.disabled === true && offlineIds.has(option.id), {
                label: count => t('projectWorkers.offlineMachines', { count }),
                detail: t('projectWorkers.offlineWorkersDetail'),
                open: offlineOpen,
                onToggle: () => setOfflineOpen(open => !open),
                icon: <Icon name="wifi-slash" size={18} color={theme.colors.text.secondary} />,
                accessory: <Icon name={offlineOpen ? 'caret-up' : 'caret-down'} size={14} color={theme.colors.text.tertiary} />,
            }) };
    }, [groupServerId, model.rootStep, model.offlineOnlyMachineIdsByServerId, offlineOpen, theme]);
    return <SelectionList testID={props.testIdPrefix ? `${props.testIdPrefix}-list` : 'machine-selector-list'}
        currentUiContextCommandScope={props.currentUiContextCommandScope}
        currentUiContextForegroundOverlay={props.currentUiContextForegroundOverlay}
        rootStep={rootStep} selectedOptionId={model.selectedOptionId} onSelect={() => {}} onRequestClose={() => {}} />;
}
