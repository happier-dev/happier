import * as React from 'react';

import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

import { ServerScopedMachineSelector } from '@/components/sessions/new/components/ServerScopedMachineSelector';
import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
    isMachineAdministrationCandidateSelectable,
    machineAdministrationTargetsEqual,
    type MachineAdministrationCandidateV1,
    type MachineAdministrationTargetStateV1,
} from '@/sync/domains/machines/administration/targetSelection';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

type MachineAdministrationPickerMachine = ServerScopedMachinePresentation & Readonly<{
    target: MachineAdministrationTargetV1;
    candidate: MachineAdministrationCandidateV1;
}>;

type CurrentTargetPresentation = Readonly<{
    title: string;
    subtitle?: string;
    detail: string;
    selected: boolean;
}>;

export type MachineAdministrationTargetSelectorProps = Readonly<{
    selection: MachineAdministrationTargetSelectionV1;
    /** Stable test-id prefix for the selected state, clear action, and shared picker. */
    testIDPrefix?: string;
    /** Contextual label for the machine scope this selector presents. */
    groupTitle?: string;
    /** Contextual copy for an unselected machine scope. */
    unselectedTitle?: string;
}>;

function targetStatusDetail(state: Exclude<MachineAdministrationTargetStateV1, { kind: 'unselected' }>): string {
    switch (state.kind) {
        case 'online':
            return t('settingsProviders.detail.machineOnline');
        case 'offline':
            return t('settingsProviders.detail.machineOffline');
        case 'locked':
        case 'missing':
        case 'replaced':
        case 'revoked':
            return t('common.unavailable');
    }
}

function targetCandidate(state: Exclude<MachineAdministrationTargetStateV1, { kind: 'unselected' }>): MachineAdministrationCandidateV1 | null {
    switch (state.kind) {
        case 'online':
            return state.machine;
        case 'offline':
        case 'locked':
        case 'replaced':
        case 'revoked':
            return state.snapshot;
        case 'missing':
            return state.snapshot;
    }
}

function presentCurrentTarget(
    state: MachineAdministrationTargetStateV1,
    unselectedTitle: string | undefined,
): CurrentTargetPresentation {
    if (state.kind === 'unselected') {
        return {
            title: unselectedTitle ?? t('newSession.noMachineSelected'),
            detail: t('common.unavailable'),
            selected: false,
        };
    }

    const candidate = targetCandidate(state);
    return {
        title: candidate?.displayName ?? state.target.machineId,
        ...(candidate?.serverLabel ? { subtitle: candidate.serverLabel } : { subtitle: state.target.serverIdentityId }),
        detail: targetStatusDetail(state),
        selected: true,
    };
}

function buildPickerGroups(
    selection: MachineAdministrationTargetSelectionV1,
): readonly ServerScopedMachineGroup<MachineAdministrationPickerMachine>[] {
    const groups = new Map<string, ServerScopedMachineGroup<MachineAdministrationPickerMachine>>();
    for (const row of selection.pickerRows) {
        const machine: MachineAdministrationPickerMachine = {
            ...row.machine,
            serverId: row.serverId,
            serverName: row.serverName,
            target: row.candidate.target,
            candidate: row.candidate,
        };
        const existing = groups.get(row.serverId);
        if (existing) {
            existing.machines.push(machine);
            continue;
        }
        groups.set(row.serverId, {
            serverId: row.serverId,
            serverName: row.serverName,
            machines: [machine],
            loading: false,
            signedOut: false,
        });
    }
    return [...groups.values()];
}

function resolvePickerAvailability(machine: MachineAdministrationPickerMachine): Readonly<{
    detail: string;
    selectable: boolean;
}> {
    if (isMachineAdministrationCandidateSelectable(machine.candidate)) {
        return { detail: t('settingsProviders.detail.machineOnline'), selectable: true };
    }
    if (machine.candidate.availability === 'offline' || machine.candidate.observation === 'stale') {
        return { detail: t('settingsProviders.detail.machineOffline'), selectable: false };
    }
    return { detail: t('common.unavailable'), selectable: false };
}

/**
 * Thin Administration adapter around the incumbent grouped machine picker.
 * The controller remains the sole settings/authority owner; this component
 * only presents its snapshot rows and returns their already-portable target.
 */
export function MachineAdministrationTargetSelector(props: MachineAdministrationTargetSelectorProps) {
    const testIDPrefix = props.testIDPrefix ?? 'machine-administration-target';
    const current = presentCurrentTarget(props.selection.state, props.unselectedTitle);
    const groups = buildPickerGroups(props.selection);
    const selectedRow = props.selection.selectedTarget
        ? props.selection.pickerRows.find((row) => machineAdministrationTargetsEqual(
            row.candidate.target,
            props.selection.selectedTarget!,
        ))
        : undefined;
    const accessibilityLabel = [current.title, current.subtitle, current.detail]
        .filter((value): value is string => Boolean(value))
        .join(', ');
    const changeTarget = React.useCallback((change: () => void) => {
        const result = runGuardedNavigation(change);
        if (result !== true) {
            fireAndForget(result, { tag: 'MachineAdministrationTargetSelector.changeTarget' });
        }
    }, []);

    return (
        <>
            <ItemGroup title={props.groupTitle ?? t('settingsProviders.detail.targetMachine')}>
                <Item
                    testID={`${testIDPrefix}.current`}
                    title={current.title}
                    subtitle={current.subtitle}
                    detail={current.detail}
                    selected={current.selected}
                    mode="info"
                    showChevron={false}
                    accessibilityLabel={accessibilityLabel}
                />
                {props.selection.selectedTarget ? (
                    <Item
                        testID={`${testIDPrefix}.clear`}
                        title={t('common.remove')}
                        showChevron={false}
                        onPress={() => changeTarget(props.selection.clearTarget)}
                    />
                ) : null}
            </ItemGroup>
            {groups.length > 0 ? (
                <ServerScopedMachineSelector
                    groups={groups}
                    selectedMachineId={props.selection.selectedTarget?.machineId ?? null}
                    selectedServerId={selectedRow?.serverId ?? null}
                    onSelect={(machine) => changeTarget(() => {
                        props.selection.selectTarget(machine.target);
                    })}
                    resolveMachineAvailability={resolvePickerAvailability}
                    testIdPrefix={`${testIDPrefix}.picker`}
                />
            ) : null}
        </>
    );
}
