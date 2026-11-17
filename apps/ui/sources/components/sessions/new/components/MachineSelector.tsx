import React from 'react';
import { getAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { type View as RNView } from 'react-native';
import { SelectionList, type SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { supportsManagedMachineSelection, useMachineSelectionListModel } from './machineSelection/useMachineSelectionListModel';
import type { ManagedMachineSelectionOffer } from './machineSelection/managedMachineSelection';
import type { ManagedSessionPlacementV1 } from '@happier-dev/protocol/teams/managedDefaults';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { resolveMachinePickerPresence } from './resolveMachinePickerPresence';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { MachineDestinationPurposeV1 } from '@happier-dev/protocol/machines/pools';
import type { MachineDestinationPlacementFacts } from './machineSelection/buildMachineDestinationModel';
import type { MachineDestinationWorkerPlacement } from '@/components/sessions/new/hooks/machines/useMachineDestinationWorkerStatus';
import { buildServerScopedMachine } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';

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
    managedPlacementSourceLabel?: string | null;
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

export function MachineSelector(props: MachineSelectorProps) {
    const presentation = props.presentation ?? 'list';
    const purpose = props.purpose ?? 'session';
    const groupServerId = props.serverId ?? getAppliedActiveServerSnapshot().serverId;
    const { binding } = useServerCredentialAccountScopeBinding(groupServerId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const [dropdownOpen, setDropdownOpen] = React.useState(false);
    const changeDropdownOpen = React.useCallback((open: boolean) => {
        setDropdownOpen(open);
        props.onDropdownOpenChange?.(open);
    }, [props.onDropdownOpenChange]);
    const requestClose = React.useCallback(() => {
        if (presentation === 'dropdown') changeDropdownOpen(false);
    }, [changeDropdownOpen, presentation]);
    const managedOffers = supportsManagedMachineSelection(purpose)
        ? props.managedMachines ?? EMPTY_MANAGED_MACHINES : EMPTY_MANAGED_MACHINES;
    const groups = React.useMemo(() => [{
        serverId: groupServerId, serverName: '', loading: false, signedOut: false,
        machines: props.machines.map(machine => buildServerScopedMachine(machine, { serverId: groupServerId, serverName: '' })),
    }], [groupServerId, props.machines]);
    const allSectionTitle = props.allSectionTitle ?? (props.machines.some(machine => machine.isShared)
        ? t('machines.destinations.yours') : t('newSession.machinePicker.allTitle'));
    const sectionTitles = React.useMemo(() => ({
        recent: props.recentSectionTitle ?? t('newSession.machinePicker.recentTitle'),
        favorites: props.favoritesSectionTitle ?? t('newSession.machinePicker.favoritesTitle'),
        all: allSectionTitle,
    }), [props.recentSectionTitle, props.favoritesSectionTitle, allSectionTitle]);
    const resolveAvailability = React.useCallback((machine: Machine) => {
        const presence = resolveMachinePickerPresence(machine, undefined, scope);
        return { selectable: presence.selectable || (props.disableOfflineMachines === false && presence.status === 'offline') };
    }, [props.disableOfflineMachines, scope]);
    const selectMachine = React.useCallback((machine: Machine) => {
        const original = props.machines.find(candidate => candidate.id === machine.id);
        if (original) {
            props.onSelect(original);
            requestClose();
        }
    }, [props.machines, props.onSelect, requestClose]);
    const toggleFavorite = React.useCallback((machine: Machine) => {
        const original = props.machines.find(candidate => candidate.id === machine.id);
        if (original) props.onToggleFavorite?.(original);
    }, [props.machines, props.onToggleFavorite]);
    const describeMachine = props.describeMachine;
    const resolveMachinePresentation = React.useCallback((machine: Machine) => ({
        subtitle: describeMachine?.(machine) ?? undefined,
    }), [describeMachine]);
    const model = useMachineSelectionListModel({
        purpose, workerPlacement: props.workerPlacement, resolveMachinePlacementFacts: props.resolveMachinePlacementFacts,
        groups, selectedMachine: props.selectedMachine, selectedServerId: groupServerId,
        managedMachines: managedOffers, managedPlacementPreset: props.managedPlacementPreset,
        managedPlacementSourceLabel: props.managedPlacementSourceLabel,
        recentMachines: props.recentMachines ?? EMPTY_MACHINES, favoriteMachines: props.favoriteMachines ?? EMPTY_MACHINES,
        onSelectMachine: selectMachine, onSelectScopedMachine: selectMachine,
        onToggleFavorite: props.onToggleFavorite ? toggleFavorite : undefined,
        showFavorites: props.showFavorites ?? true, showRecent: props.showRecent ?? true, showSearch: props.showSearch ?? true,
        showCliGlyphs: presentation === 'list' && (props.showCliGlyphs ?? true), autoDetectCliGlyphs: props.autoDetectCliGlyphs ?? true,
        serverId: props.serverId, favoriteGroupPlacement: props.favoriteGroupPlacement, testIdPrefix: props.testIdPrefix,
        disableOfflineMachines: props.disableOfflineMachines,
        resolveMachineAvailability: props.disableOfflineMachines === false ? resolveAvailability : undefined,
        resolveMachinePresentation: describeMachine ? resolveMachinePresentation : undefined,
        includeSelectedUnavailableMachineId: props.includeSelectedUnavailableMachine ? props.selectedMachine?.id : null,
        searchPlaceholder: props.searchPlaceholder ?? t('newSession.machinePicker.searchPlaceholder'),
        emptyStateLabel: props.noItemsMessage ?? t('newSession.machinePicker.emptyMessage'), sectionTitles,
    });
    const clearOption = props.dropdownClearOption;
    const sections = React.useMemo<readonly SelectionListSectionDescriptor[]>(() => clearOption ? [{
        kind: 'static' as const, id: 'clear', options: [{
            id: CLEAR_OPTION_ID, label: clearOption.title, subtitle: clearOption.subtitle,
            onSelect: () => { clearOption.onSelect(); requestClose(); },
        }],
    }, ...model.rootStep.sections] : model.rootStep.sections, [clearOption, model.rootStep.sections, requestClose]);
    const rootStep = React.useMemo(() => ({ ...model.rootStep, sections }), [model.rootStep, sections]);
    const closeManagedSelection = React.useCallback((id: string) => {
        if (managedOffers.some(offer => offer.id === id)) requestClose();
    }, [managedOffers, requestClose]);
    const selectedOptionId = model.selectedOptionId ?? (clearOption?.current ? CLEAR_OPTION_ID : null);
    const renderList = (maxHeight?: number) => <SelectionList
        testID={props.testIdPrefix ? `${props.testIdPrefix}-list` : 'machine-selector-list'}
        currentUiContextCommandScope={props.currentUiContextCommandScope}
        currentUiContextForegroundOverlay={props.currentUiContextForegroundOverlay}
        maxHeight={maxHeight} rootStep={rootStep} selectedOptionId={selectedOptionId}
        onSelect={closeManagedSelection} onRequestClose={requestClose} />;
    // The list stays folded; trigger metadata must still include the selected Machine.
    const dropdownOptions = React.useMemo(() => {
        const options = sections.flatMap(section => section.kind === 'static'
            ? section.options.map(option => ({ option, category: section.title })) : []);
        if (model.selectedOption && !options.some(({ option }) => option.id === model.selectedOption?.id)) {
            options.push({ option: model.selectedOption, category: undefined });
        }
        return options;
    }, [sections, model.selectedOption]);
    const dropdownItems: readonly DropdownMenuItem[] = React.useMemo(() => dropdownOptions.map(({ option, category }) => ({
        id: option.id, testID: option.testID, title: option.label, subtitle: option.subtitle, disabled: option.disabled, category,
    })), [dropdownOptions]);
    const selectedTitle = model.selectedOption?.label ?? (clearOption?.current ? clearOption.title : null);
    if (presentation !== 'dropdown') return renderList();
    const dropdown = <DropdownMenu
        open={dropdownOpen} onOpenChange={changeDropdownOpen}
        renderContent={({ maxHeight }) => renderList(maxHeight)}
        items={dropdownItems} selectedId={selectedOptionId}
        onSelect={id => {
            const option = dropdownOptions.find(candidate => candidate.option.id === id)?.option;
            if (!option || option.disabled) return;
            option.onSelect?.();
            closeManagedSelection(id);
        }}
        rowKind="item" variant="selectable" search={false}
        emptyLabel={props.noItemsMessage ?? t('newSession.machinePicker.emptyMessage')}
        matchTriggerWidth connectToTrigger popoverBoundaryRef={props.popoverBoundaryRef}
        itemTrigger={{
            title: props.dropdownTitle ?? t('newSession.selectMachineTitle'),
            subtitle: props.dropdownSubtitle ?? selectedTitle ?? t('newSession.selectMachineDescription'),
            showSelectedDetail: false, showSelectedSubtitle: false,
            // A Machine choice is a preference row (settings, Team defaults): preference rows carry no icon.
            itemProps: { testID: props.dropdownTestID },
        }} />;
    return props.dropdownInCallerSection ? dropdown : <ItemGroup title="">{dropdown}</ItemGroup>;
}
