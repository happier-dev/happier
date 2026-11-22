import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import { SelectionList, resolvePopoverSelectionListHeightBehavior, type SelectionListStep } from '@/components/ui/selectionList';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { ManagedSessionPlacementV1 } from '@happier-dev/protocol/teams/managedDefaults';
import type { MachineIsolationWorkKind } from '@/components/machines/security/isolation/machineIsolationChoices';

import type { ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import {
    useMachineSelectionListModel,
    type MachineSelectionAvailability,
    type MachineSelectionPresentation,
    type ScopedSelectionMachine,
    type ServerScopedMachinePoolGroup,
    type ServerScopedMachinePoolSelection,
    type TemporaryComputerSelection,
} from './machineSelection/useMachineSelectionListModel';
import type { MachinePoolSelectionStatus } from '@/components/sessions/new/hooks/machines/useMachinePoolSelection';
import type { ManagedMachineDestinationProjection, ManagedMachineSelectionDraft, ManagedMachineSelectionOffer, ManagedMachineUse } from './machineSelection/managedMachineSelection';
import type { PresentManagedMachineConfiguration } from './machineSelection/ManagedMachineSelectionOffers';

const ManagedMachineSelectionOffers = retryableLazy<React.ComponentProps<
    typeof import('./machineSelection/ManagedMachineSelectionOffers').ManagedMachineSelectionOffers
>>(() => import('./machineSelection/ManagedMachineSelectionOffers')
    .then(module => ({ default: module.ManagedMachineSelectionOffers })));

/**
 * The one machine list: the new-session composer popover and picker route, and the settings
 * machine-scope chip, all render this content. Callers that are not launching a session turn off the
 * launch-only concepts (favorites, recents, CLI glyphs, pools, Temporary computer) and may supply
 * their own availability decision.
 */
export type NewSessionMachineSelectionContentProps<TMachine extends MachineDisplayRenderable = Machine> = Readonly<{
    groups: ReadonlyArray<ServerScopedMachineGroup<ScopedSelectionMachine<TMachine>>>;
    poolGroups?: ReadonlyArray<ServerScopedMachinePoolGroup>;
    selectedMachine: TMachine | null;
    selectedServerId: string | null;
    recentMachines: ReadonlyArray<TMachine>;
    favoriteMachines: ReadonlyArray<TMachine>;
    onSelectMachine: (machine: TMachine) => void;
    onSelectScopedMachine: (machine: ScopedSelectionMachine<TMachine>) => void;
    resolveMachineAvailability?: (machine: TMachine, serverId: string) => MachineSelectionAvailability;
    resolveMachinePresentation?: (machine: TMachine) => MachineSelectionPresentation;
    onSelectPool?: (selection: ServerScopedMachinePoolSelection) => void;
    temporaryComputers?: readonly TemporaryComputerSelection[];
    managedMachines?: readonly ManagedMachineSelectionOffer[];
    selectedManagedMachine?: ManagedMachineSelectionDraft | null;
    managedPlacementPreset?: Extract<ManagedSessionPlacementV1, { kind: 'preset' }> | null;
    managedPlacementSourceLabel?: string | null;
    onSelectManagedMachine?: ManagedMachineUse;
    /** The composer holds a drafted prompt, read as the configurator opens: its receipt then creates and starts the session. */
    managedMachineStartsSession?: () => boolean;
    /** Opens the Machines presets from the managed group's header. */
    onOpenManagedPresets?: () => void;
    /** Opens the Add a machine flow from the list's last row ("Connect a computer…"). */
    onConnectMachine?: () => void;
    /** Called as a preset's or a one-off's configurator opens; a popover host closes itself here. */
    onConfigureManagedMachine?: () => void;
    /** A host sheet presents the "New machine" review in place of its own body instead of a second dialog. */
    presentManagedMachineConfiguration?: PresentManagedMachineConfiguration;
    onManagedMachineProjection?: (serverId: string, projection: ManagedMachineDestinationProjection) => void;
    poolSelectionStatus?: MachinePoolSelectionStatus;
    onRefreshMachines?: () => void;
    onRefreshPools?: (serverId: string) => void;
    onOpenPoolSettings?: (target: Readonly<{ serverId: string; poolId: string }>) => void;
    onDismissPoolSelection?: () => void;
    serverId?: string | null;
    onToggleFavorite?: (machine: TMachine) => void;
    showFavorites?: boolean;
    showRecent?: boolean;
    /** Domains that own availability keep canonical row order rather than launch prioritization. */
    disableOfflineMachines?: boolean;
    showSearch?: boolean;
    searchPlacement?: 'header' | 'favorites' | 'all';
    testIdPrefix?: string;
    /** Test id of the list itself. */
    testID?: string;
    showCliGlyphs?: boolean;
    autoDetectCliGlyphs?: boolean;
    maxHeight?: number;
    /**
     * `inline`: laid out in a page (the New Session wizard's Machine section) rather than a popover or
     * the picker route: page rows at their natural height, and the search field waits for the user,
     * so opening the page does not scroll it down to this list.
     */
    presentation?: 'inline';
    /** Content after the last machine that scrolls with the list, so a long list cannot clip it (see `SelectionList` `bodyFooter`). */
    bodyFooter?: React.ReactNode;
    /** Exposes the list to an agent's UI commands under this scope, as `MachineSelector` does. */
    currentUiContextCommandScope?: string;
    currentUiContextForegroundOverlay?: boolean;
    /**
     * A host's choice that is no particular Machine ("Your usual Machine", "Auto"), listed first and
     * marked while it holds, as the folder picker's "No folder".
     */
    defaultOption?: MachineSelectionDefaultOption;
    /** The work a Session started from this list is; each reachable row then says what it does there (lab scene 2). */
    isolationWorkKind?: MachineIsolationWorkKind;
}>;

export type MachineSelectionDefaultOption = Readonly<{
    title: string;
    subtitle?: string;
    selected: boolean;
    onSelect: () => void;
}>;

const DEFAULT_OPTION_ID = 'machine-default';

export function NewSessionMachineSelectionContent<TMachine extends MachineDisplayRenderable = Machine>(
    props: NewSessionMachineSelectionContentProps<TMachine>,
) {
    const [loadedOffers, setLoadedOffers] = React.useState<Readonly<{
        serverId: string; offers: readonly ManagedMachineSelectionOffer[];
    }> | null>(null);
    const projectionHandler = React.useRef(props.onManagedMachineProjection);
    projectionHandler.current = props.onManagedMachineProjection;
    const receiveOffers = React.useCallback((serverId: string, offers: readonly ManagedMachineSelectionOffer[], projection: ManagedMachineDestinationProjection) => {
        setLoadedOffers(current => current?.serverId === serverId && current.offers === offers ? current : { serverId, offers });
        projectionHandler.current?.(serverId, projection);
    }, []);
    const managedMachines = props.managedMachines ?? (loadedOffers?.serverId === props.selectedServerId ? loadedOffers.offers : undefined);
    const listModel = useMachineSelectionListModel<TMachine>({
        purpose: 'session',
        groups: props.groups,
        poolGroups: props.poolGroups,
        selectedMachine: props.selectedMachine,
        selectedServerId: props.selectedServerId,
        recentMachines: props.recentMachines,
        favoriteMachines: props.favoriteMachines,
        onSelectMachine: props.onSelectMachine,
        onSelectScopedMachine: props.onSelectScopedMachine,
        resolveMachineAvailability: props.resolveMachineAvailability,
        resolveMachinePresentation: props.resolveMachinePresentation,
        onSelectPool: props.onSelectPool,
        temporaryComputers: props.temporaryComputers,
        managedMachines,
        selectedManagedMachine: props.selectedManagedMachine,
        managedPlacementPreset: props.managedPlacementPreset,
        managedPlacementSourceLabel: props.managedPlacementSourceLabel,
        onSelectManagedMachine: props.onSelectManagedMachine,
        onOpenManagedPresets: props.onOpenManagedPresets,
        onConnectMachine: props.onConnectMachine,
        poolSelectionStatus: props.poolSelectionStatus,
        onRefreshMachines: props.onRefreshMachines,
        onRefreshPools: props.onRefreshPools,
        onOpenPoolSettings: props.onOpenPoolSettings,
        onDismissPoolSelection: props.onDismissPoolSelection,
        serverId: props.serverId,
        onToggleFavorite: props.onToggleFavorite,
        showFavorites: props.showFavorites ?? true,
        showRecent: props.showRecent ?? true,
        disableOfflineMachines: props.disableOfflineMachines,
        showSearch: props.showSearch ?? true,
        // A picker row says its status and nothing more at rest (lab m-pick); the agents live on the machine's page.
        showCliGlyphs: props.showCliGlyphs ?? false,
        autoDetectCliGlyphs: props.autoDetectCliGlyphs ?? true,
        favoriteGroupPlacement: 'afterRecent',
        testIdPrefix: props.testIdPrefix,
        isolationWorkKind: props.isolationWorkKind,
    });

    const defaultOption = props.defaultOption;
    const rootStep = React.useMemo((): SelectionListStep => defaultOption ? {
        ...listModel.rootStep,
        sections: [{
            kind: 'static',
            id: DEFAULT_OPTION_ID,
            options: [{
                id: DEFAULT_OPTION_ID,
                label: defaultOption.title,
                ...(defaultOption.subtitle === undefined ? {} : { subtitle: defaultOption.subtitle }),
                ...(props.testIdPrefix ? { testID: `${props.testIdPrefix}-option:default` } : {}),
                onSelect: defaultOption.onSelect,
            }],
        }, ...listModel.rootStep.sections],
    } : listModel.rootStep, [defaultOption, listModel.rootStep, props.testIdPrefix]);
    const selectedOptionId = defaultOption?.selected ? DEFAULT_OPTION_ID : listModel.selectedOptionId;

    const inline = props.presentation === 'inline';
    const maxHeight = inline ? undefined : props.maxHeight;
    return (
        <>
        {props.managedMachines === undefined && props.selectedServerId && props.onSelectManagedMachine ?
            <React.Suspense fallback={null}><ManagedMachineSelectionOffers key={props.selectedServerId} serverId={props.selectedServerId}
                onOffers={receiveOffers} onUse={props.onSelectManagedMachine} startsSession={props.managedMachineStartsSession}
                onConfigure={props.onConfigureManagedMachine} presentConfiguration={props.presentManagedMachineConfiguration} /></React.Suspense> : null}
        <SelectionList
            testID={props.testID ?? 'new-session-machine-list'}
            currentUiContextCommandScope={props.currentUiContextCommandScope}
            currentUiContextForegroundOverlay={props.currentUiContextForegroundOverlay}
            rootStep={rootStep}
            selectedOptionId={selectedOptionId}
            onSelect={() => {}}
            onRequestClose={() => {}}
            autoFocusInputOnWeb={!inline}
            // In a popover the picker is a transient menu: the shared menu rows (inset, rounded,
            // menu height), as the composer's other pickers draw theirs. The picker page keeps list rows.
            optionPresentation={maxHeight === undefined ? undefined : 'menu'}
            maxHeight={maxHeight}
            bodyFooter={props.bodyFooter}
            heightBehavior={
                maxHeight === undefined
                    ? undefined
                    : resolvePopoverSelectionListHeightBehavior()
            }
        />
        </>
    );
}
