import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import { SelectionList, resolvePopoverSelectionListHeightBehavior } from '@/components/ui/selectionList';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';

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
import type { ManagedMachineDestinationProjection, ManagedMachineSelectionDraft, ManagedMachineSelectionOffer } from './machineSelection/managedMachineSelection';

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
    onSelectManagedMachine?: (draft: ManagedMachineSelectionDraft) => void;
    /** Opens the Machines presets from the managed group's header. */
    onOpenManagedPresets?: () => void;
    /** Opens the Add a machine flow from the list's last row ("Connect a computer…"). */
    onConnectMachine?: () => void;
    /** Called as a preset's or a one-off's configurator opens; a popover host closes itself here. */
    onConfigureManagedMachine?: () => void;
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
}>;

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
        showCliGlyphs: props.showCliGlyphs ?? true,
        autoDetectCliGlyphs: props.autoDetectCliGlyphs ?? true,
        favoriteGroupPlacement: 'afterRecent',
        testIdPrefix: props.testIdPrefix,
    });

    const inline = props.presentation === 'inline';
    const maxHeight = inline ? undefined : props.maxHeight;
    return (
        <>
        {props.managedMachines === undefined && props.selectedServerId && props.onSelectManagedMachine ?
            <React.Suspense fallback={null}><ManagedMachineSelectionOffers key={props.selectedServerId} serverId={props.selectedServerId}
                onOffers={receiveOffers} onUse={props.onSelectManagedMachine}
                onConfigure={props.onConfigureManagedMachine} /></React.Suspense> : null}
        <SelectionList
            testID={props.testID ?? 'new-session-machine-list'}
            rootStep={listModel.rootStep}
            selectedOptionId={listModel.selectedOptionId}
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
