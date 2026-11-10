import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ManagedSessionDefaultsV1 } from '@happier-dev/protocol/teams';
import type { ManagedMachinePresetCreationV1, ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { MachineSelector } from '@/components/sessions/new/components/MachineSelector';
import { useManagedMachineSelectionOffers } from '@/components/sessions/new/components/machineSelection/ManagedMachineSelectionOffers';
import { useMachinePreset, useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { getMachineDisplayName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

import type { TeamSectionContext } from '../teamSectionContext';
import { withPlacement } from './memberDefaults';

const EMPTY_MACHINES: readonly Machine[] = Object.freeze([]);
const EMPTY_PRESETS: readonly ManagedMachinePresetV1[] = Object.freeze([]);

type MachineDefaultState = Readonly<{
    serverId: string;
    defaults: ManagedSessionDefaultsV1;
    editable: boolean;
    disabled: boolean;
    conflictNote: string;
    save: (next: ManagedSessionDefaultsV1) => void;
}>;

/** Chooses future placement through New Session's preset source; it never acquires a Machine. */
export const TeamMemberMachineDefaultRow = React.memo(function TeamMemberMachineDefaultRow(
    props: Readonly<{
        state: MachineDefaultState;
        conflict: boolean;
        testID: string;
        onApprovalPending: TeamSectionContext['requestApproval'];
    }>,
) {
    const { state } = props;
    const { theme } = useUnistyles();
    const machines = useMachineListForServer(state.serverId) ?? EMPTY_MACHINES;
    const placement = state.defaults.placement;
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
    const choosePreset = useEventCallback((preset: (ManagedMachinePresetV1 & ManagedMachinePresetCreationV1) | null) => {
        if (!preset || state.disabled || placement?.kind === 'preset'
            && placement.homeId === preset.homeId && placement.presetId === preset.id) return;
        state.save(withPlacement(state.defaults, { kind: 'preset', homeId: preset.homeId, presetId: preset.id }));
    });
    // The closed field shows its selected record through the same offer, so it reads as the open list does.
    const selectedPreset = selectedRecord.state.value;
    const offerPresets = React.useMemo(() => open ? presetRows : selectedPreset ? [selectedPreset] : EMPTY_PRESETS,
        [open, presetRows, selectedPreset]);
    const { binding } = useServerCredentialAccountScopeBinding(state.serverId);
    const allOffers = useManagedMachineSelectionOffers({ homeId, binding, serverId: state.serverId,
        presets: offerPresets, machines, configure: choosePreset });
    // Only saved preset identities can be persisted as member defaults; one-off reviews cannot.
    const offers = React.useMemo(() => allOffers.filter(offer => offer.kind === 'preset'), [allOffers]);
    const selectedPresetTitle = placement?.kind === 'preset' ? offers.find(offer =>
        offer.homeId === placement.homeId && offer.presetId === placement.presetId)?.title
        ?? selectedRecord.state.value?.name : undefined;
    const selectedMachine = placement?.kind === 'machine' && placement.target.serverId === state.serverId
        ? machines.find(machine => machine.id === placement.target.machineId) ?? null : null;
    const unseen = placement === undefined || selectedMachine || selectedPresetTitle ? null : t(
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
            dropdownSubtitle={[unseen, note].filter(Boolean).join(' ') || undefined}
            dropdownTestID={props.testID}
            testIdPrefix={props.testID}
            dropdownClearOption={{
                title: t('teams.settings.memberDefaults.none'), current: placement === undefined,
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
            subtitle={note ?? undefined}
            subtitleLines={0}
            detail={selectedPresetTitle ?? (selectedMachine
                ? resolveMachineDisplayNames(machines).get(selectedMachine.id) ?? getMachineDisplayName(selectedMachine) ?? selectedMachine.id
                : unseen ?? t('teams.settings.memberDefaults.none'))}
            icon={<Icon name="desktop" size={24} color={theme.colors.text.secondary} />}
            mode="info"
            showChevron={false}
        />}
        {error ? <SurfaceStateCard kind="error" size="line" title={t('machinePresets.loadFailed')}
            diagnosticCode={error} action={{ label: t('common.retry'), onPress: open ? presets.refresh : selectedRecord.refresh }} /> : null}
    </>;
});
