import * as React from 'react';
import type { ManagedSessionDefaultsV1 } from '@happier-dev/protocol/teams';
import type { OpenedManagedMachinePresetCreationV1, OpenedManagedMachinePresetV1, ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';

import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { useManagedMachineSelectionOffers } from '@/components/sessions/new/components/machineSelection/ManagedMachineSelectionOffers';
import { useMachinePreset, useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { ProjectSessionDefaultsInheritance } from '@/hooks/projects/useProjectSessionDefaultsSectionAdapter';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer, useMachineListForServerSelection } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

import type { TeamSectionContext } from '../teamSectionContext';
import { describeInheritedDefaultSource } from './inheritedDefaultSourceLabel';
import { withPlacement } from './memberDefaults';

const EMPTY_MACHINES: readonly Machine[] = Object.freeze([]);
const EMPTY_PRESETS: readonly ManagedMachinePresetListEntryV1[] = Object.freeze([]);

type MachineDefaultState = Readonly<{
    serverId: string;
    teamId: string;
    defaults: ManagedSessionDefaultsV1;
    editable: boolean;
    disabled: boolean;
    conflictNote: string;
    save: (next: ManagedSessionDefaultsV1) => void;
    inheritance?: ProjectSessionDefaultsInheritance;
}>;

/** Chooses future placement through New Session's preset source; it never acquires a Machine. */
export const TeamMemberMachineDefaultRow = React.memo(function TeamMemberMachineDefaultRow(
    props: Readonly<{
        state: MachineDefaultState;
        conflict: boolean;
        testID: string;
        onApprovalPending?: TeamSectionContext['requestApproval'];
    }>,
) {
    const { state } = props;
    const machines = useMachineListForServer(state.serverId, state.editable) ?? EMPTY_MACHINES;
    // The accessible inventory supplies candidates; the server checks audience
    // usability when saving the default and returns a typed refusal if needed.
    const placement = state.defaults.placement;
    const selectedMachineId = placement?.kind === 'machine' && placement.target.serverId === state.serverId
        ? placement.target.machineId : null;
    const selectReadOnlyMachineTitle = React.useCallback((inventory: readonly Machine[]) => {
        if (state.editable || !selectedMachineId) return null;
        const machine = inventory.find(candidate => candidate.id === selectedMachineId);
        return machine ? resolveMachineDisplayNames(inventory).get(machine.id) ?? getMachineDisplayName(machine) ?? machine.id : null;
    }, [selectedMachineId, state.editable]);
    const readOnlyMachineTitle = useMachineListForServerSelection(state.serverId, selectReadOnlyMachineTitle);
    // A project scope with nothing set here starts from the next layer down: show that value and whose it is.
    const inherited = placement === undefined ? state.inheritance?.placement : undefined;
    const inheritedPlacement = inherited?.value;
    const inheritedSource = inheritedPlacement ? describeInheritedDefaultSource(inherited.source, inherited.names) : null;
    const inheritedMachineId = inheritedPlacement?.kind === 'machine' && inheritedPlacement.target.serverId === state.serverId
        ? inheritedPlacement.target.machineId : null;
    const selectInheritedMachineTitle = React.useCallback((inventory: readonly Machine[]) => {
        const machine = inheritedMachineId ? inventory.find(candidate => candidate.id === inheritedMachineId) : undefined;
        return machine ? resolveMachineDisplayNames(inventory).get(machine.id) ?? getMachineDisplayName(machine) ?? machine.id : null;
    }, [inheritedMachineId]);
    const inheritedMachineTitle = useMachineListForServerSelection(state.serverId, selectInheritedMachineTitle);
    const [open, setOpen] = React.useState(false);
    // Load selectable targets only while open; a closed field reads only its selected record.
    const serverIds = React.useMemo(() => open ? [state.serverId] : [],
        [open, state.serverId]);
    const presets = useMachinePresets(serverIds, props.onApprovalPending);
    const presetRows = presets.presetsByServerId[state.serverId] ?? EMPTY_PRESETS;
    const presetState = presets.statesByServerId[state.serverId];
    const homeId = getServerProfileById(state.serverId)?.serverIdentityId;
    const selectedRecord = useMachinePreset(state.serverId, !open && placement?.kind === 'preset'
        && placement.homeId === homeId ? placement.presetId : '', props.onApprovalPending);
    const inheritedRecord = useMachinePreset(state.serverId, inheritedPlacement?.kind === 'preset'
        && inheritedPlacement.homeId === homeId ? inheritedPlacement.presetId : '', props.onApprovalPending);
    const inheritedTitle = inheritedPlacement?.kind === 'preset' ? inheritedRecord.state.value?.name ?? t('teams.settings.memberDefaults.preset')
        : inheritedPlacement ? inheritedMachineTitle ?? t('teams.settings.memberDefaults.unavailableMachine') : null;
    const choosePreset = useEventCallback((preset: (OpenedManagedMachinePresetV1 & OpenedManagedMachinePresetCreationV1) | null) => {
        if (!preset || state.disabled || placement?.kind === 'preset'
            && placement.homeId === preset.homeId && placement.presetId === preset.id) return;
        state.save(withPlacement(state.defaults, { kind: 'preset', homeId: preset.homeId, presetId: preset.id }));
    });
    // The closed field shows its selected record through the same offer, so it reads as the open list does.
    const selectedPreset = selectedRecord.state.value;
    const offerPresets = React.useMemo(() => (open ? presetRows : selectedPreset ? [selectedPreset] : EMPTY_PRESETS)
        .filter(preset => preset.owner.kind === 'team' && preset.owner.teamId === state.teamId),
    [open, presetRows, selectedPreset, state.teamId]);
    const { binding } = useServerCredentialAccountScopeBinding(state.serverId);
    const allOffers = useManagedMachineSelectionOffers({ homeId, binding, serverId: state.serverId,
        presets: offerPresets, configure: choosePreset });
    // Only saved preset identities can be persisted as member defaults; one-off reviews cannot.
    const offers = React.useMemo(() => allOffers.filter(offer => offer.kind === 'preset'), [allOffers]);
    const selectedPresetTitle = placement?.kind === 'preset' ? offers.find(offer =>
        offer.homeId === placement.homeId && offer.presetId === placement.presetId)?.title
        ?? selectedRecord.state.value?.name : undefined;
    const selectedMachine = machines.find(machine => machine.id === selectedMachineId) ?? null;
    const unseen = placement === undefined || selectedMachine || readOnlyMachineTitle || selectedPresetTitle ? null : t(
        placement.kind === 'preset' ? 'teams.settings.memberDefaults.preset' : 'teams.settings.memberDefaults.unavailableMachine');
    const note = props.conflict ? state.conflictNote : null;
    const error = open ? presetState?.error : placement?.kind === 'preset' ? selectedRecord.state.error : null;

    return <>
        {state.editable ? <MachineSelector
            presentation="dropdown"
            dropdownInCallerSection
            serverId={state.serverId}
            machines={machines}
            selectedMachine={selectedMachine}
            managedMachines={offers}
            managedPlacementPreset={placement?.kind === 'preset' ? placement : null}
            onDropdownOpenChange={setOpen}
            showFavorites={false}
            showRecent={false}
            // A default names where Sessions should start later, not where one can start now.
            disableOfflineMachines={false}
            includeSelectedUnavailableMachine
            noItemsMessage={presetState?.loading ? t('common.loading') : undefined}
            dropdownTitle={t('teams.settings.memberDefaults.machine')}
            // The field names the selection; the line beneath carries only what the field cannot.
            // Otherwise the line says what the default decides (new sessions), not "this session".
            dropdownSubtitle={[inheritedSource, unseen, note].filter(Boolean).join(' ')
                || t('teams.settings.memberDefaults.machineDescription')}
            dropdownTestID={props.testID}
            testIdPrefix={props.testID}
            dropdownClearOption={{
                title: inheritedTitle ? t('teams.settings.memberDefaults.useDefault', { value: inheritedTitle }) : t('teams.settings.memberDefaults.none'),
                subtitle: inheritedSource ?? undefined,
                current: placement === undefined,
                onSelect: () => {
                    if (!state.disabled && placement !== undefined) state.save(withPlacement(state.defaults, undefined));
                },
            }}
            onSelect={machine => {
                if (state.disabled || machine.id === selectedMachine?.id) return;
                state.save(withPlacement(state.defaults, { kind: 'machine',
                    target: { serverId: state.serverId, machineId: machine.id } }));
            }}
        /> : <Item
            testID={props.testID}
            title={t('teams.settings.memberDefaults.machine')}
            subtitle={[inheritedSource, note].filter(Boolean).join(' ') || undefined}
            subtitleLines={0}
            detail={selectedPresetTitle ?? readOnlyMachineTitle ?? inheritedTitle ?? unseen ?? t('teams.settings.memberDefaults.none')}
            mode="info"
            showChevron={false}
        />}
        {error ? <SurfaceStateCard kind="error" size="line" title={t('machinePresets.loadFailed')}
            diagnosticCode={error} action={{ label: t('common.retry'), onPress: open ? presets.refresh : selectedRecord.refresh }} /> : null}
    </>;
});
