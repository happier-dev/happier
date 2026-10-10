import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

import { ServerScopedMachineSelector } from '@/components/sessions/new/components/ServerScopedMachineSelector';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import type { MachineSelectionAvailability } from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip, type SelectionListFilter } from '@/components/ui/selectionList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveHomeDisplayNameForServerIdentity } from '@/components/settings/server/homeDisplayName';
import { isAddressOnlyName } from '@/sync/domains/server/serverProfiles';
import {
    isMachineAdministrationCandidateSelectable,
    machineAdministrationTargetsEqual,
    readMachineAdministrationCandidateName,
    resolveMachineAdministrationTargetState,
    type MachineAdministrationCandidateV1,
    type MachineAdministrationTargetStateV1,
} from '@/sync/domains/machines/administration/targetSelection';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { lockedMachineName, unnamedMachineName } from '@/utils/sessions/machineDisplayNames';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

type MachineAdministrationPickerMachine = ServerScopedMachinePresentation & Readonly<{
    target: MachineAdministrationTargetV1;
    candidate: MachineAdministrationCandidateV1;
}>;

type CurrentTargetPresentation = Readonly<{
    title: string;
    subtitle?: string;
    detail?: string;
    selected: boolean;
    /** The stored target is gone from its Home: the row offers another machine instead of "Change". */
    gone: boolean;
}>;

export type MachineAdministrationTargetSelectorProps = Readonly<{
    selection: MachineAdministrationTargetSelectionV1;
    /**
     * `section`: a titled group. `context`: a compact scope row for screens whose content already
     * provides a heading. `chip`: a compact trigger for a page header's actions slot; the same picker
     * opens in a popover.
     */
    presentation?: 'section' | 'context' | 'chip';
    /** Stable test-id prefix for the selected state, clear action, and shared picker. */
    testIDPrefix?: string;
    /** Contextual label for the machine scope this selector presents. */
    groupTitle?: string;
    /** Contextual copy for an unselected machine scope. */
    unselectedTitle?: string;
    /** Domain-owned availability layered over the canonical Machine row. */
    resolveCandidateAvailability?: (candidate: MachineAdministrationCandidateV1) => Readonly<{
        detail: string;
        selectable: boolean;
    }>;
    /** Safe domain presentation when opaque Machine ids must not be disclosed. */
    resolveCandidatePresentation?: (candidate: MachineAdministrationCandidateV1) => Readonly<{
        title: string;
        subtitle?: string;
    }>;
    missingTargetTitle?: string;
    /** A subtitle for a missing target (`null` or omitted: none; opaque ids are never shown). */
    missingTargetSubtitle?: string | null;
    disabled?: boolean;
    /**
     * `chip` only: control the picker popover from the page, so a state that says "Choose a machine"
     * can open the same list the chip does.
     */
    chipOpen?: boolean;
    onChipOpenChange?: (open: boolean) => void;
}>;

function targetStatusDetail(kind: Exclude<MachineAdministrationTargetStateV1['kind'], 'unselected'>): string {
    switch (kind) {
        case 'online':
            return t('settingsProviders.detail.machineOnline');
        case 'offline':
            return t('settingsProviders.detail.machineOffline');
        case 'locked':
            return t('settingsPlugins.targetSelection.locked');
        case 'missing':
            return t('settingsPlugins.targetSelection.missing');
        case 'replaced':
            return t('settingsPlugins.targetSelection.replaced');
        case 'revoked':
            return t('settingsPlugins.targetSelection.revoked');
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

/**
 * How a target's Home is named beside its machine: the Home's display name, else the server label the
 * inventory carries when it is a real name. Never an address or an identity id.
 */
function presentTargetHome(
    target: MachineAdministrationTargetV1,
    candidate: MachineAdministrationCandidateV1 | null,
): string | undefined {
    const homeName = resolveHomeDisplayNameForServerIdentity(target.serverIdentityId);
    if (homeName) return homeName;
    const serverLabel = candidate?.serverLabel.trim() ?? '';
    return serverLabel && !isAddressOnlyName(serverLabel) && serverLabel !== target.serverIdentityId
        ? serverLabel
        : undefined;
}

function presentCurrentTarget(
    state: MachineAdministrationTargetStateV1,
    unselectedTitle: string | undefined,
    missingTargetTitle: string | undefined,
    missingTargetSubtitle: string | null | undefined,
    resolveCandidatePresentation: MachineAdministrationTargetSelectorProps['resolveCandidatePresentation'],
    resolveCandidateAvailability: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability'],
    compact: boolean,
): CurrentTargetPresentation {
    if (state.kind === 'unselected') {
        return {
            title: unselectedTitle ?? t(compact ? 'newSession.selectMachineTitle' : 'newSession.noMachineSelected'),
            detail: compact ? undefined : t('common.unavailable'),
            selected: false,
            gone: false,
        };
    }

    const candidate = targetCandidate(state);
    if (!candidate && state.kind === 'missing' && state.inventoryKnown === false) {
        const inventoryStatus = state.inventoryStatus ?? 'loading';
        return {
            title: inventoryStatus === 'loading'
                ? t('common.loading')
                : inventoryStatus === 'signedOut' ? t('server.signedOut') : t('common.unavailable'),
            subtitle: missingTargetSubtitle ?? undefined,
            selected: true,
            gone: false,
        };
    }
    if (!candidate) {
        // The saved machine is no longer in its Home's inventory. Its ids mean nothing to a person, so
        // the row says where it went and offers another machine.
        const homeName = resolveHomeDisplayNameForServerIdentity(state.target.serverIdentityId);
        return {
            title: missingTargetTitle ?? (compact
                ? t('settingsPlugins.targetSelection.chooseAnother')
                : homeName
                    ? t('settingsPlugins.targetSelection.missingInHome', { home: homeName })
                    : t('settingsPlugins.targetSelection.missingInThisHome')),
            subtitle: missingTargetSubtitle ?? undefined,
            selected: true,
            gone: true,
        };
    }
    const presentation = resolveCandidatePresentation?.(candidate);
    const availability = resolveCandidateAvailability?.(candidate);
    return {
        title: presentation?.title
            ?? readMachineAdministrationCandidateName(candidate)
            ?? (candidate.availability === 'locked' ? lockedMachineName() : unnamedMachineName()),
        subtitle: presentation?.subtitle ?? presentTargetHome(state.target, candidate),
        detail: availability?.detail ?? targetStatusDetail(state.kind),
        selected: true,
        gone: false,
    };
}

/** The same scope explanation used by the selector, for a page blocked on its chosen machine. */
export function presentMachineAdministrationTargetState(state: MachineAdministrationTargetStateV1): Readonly<{ title: string; detail?: string }> {
    return presentCurrentTarget(state, undefined, undefined, undefined, undefined, undefined, false);
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
    const presentation = presentMachineAdministrationTargetState(resolveMachineAdministrationTargetState({
        storedTarget: machine.target, candidates: [machine.candidate],
    }));
    return {
        detail: presentation.detail ?? presentation.title,
        selectable: isMachineAdministrationCandidateSelectable(machine.candidate),
    };
}

/**
 * Thin Administration adapter around the incumbent grouped machine picker.
 * The controller remains the sole settings/authority owner; this component
 * only presents its snapshot rows and returns their already-portable target.
 */
export function MachineAdministrationTargetSelector(props: MachineAdministrationTargetSelectorProps) {
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const testIDPrefix = props.testIDPrefix ?? 'machine-administration-target';
    const groupTitle = props.groupTitle ?? t('settingsProviders.detail.targetMachine');
    const compact = props.presentation === 'context' || props.presentation === 'chip';
    const current = presentCurrentTarget(
        props.selection.state,
        props.unselectedTitle,
        props.missingTargetTitle,
        props.missingTargetSubtitle,
        props.resolveCandidatePresentation,
        props.resolveCandidateAvailability,
        compact,
    );
    const groups = buildPickerGroups(props.selection);
    const canOpenPicker = groups.length > 0 || (compact && props.selection.selectedTarget !== null);
    const selectedRow = props.selection.selectedTarget
        ? props.selection.pickerRows.find((row) => machineAdministrationTargetsEqual(
            row.candidate.target,
            props.selection.selectedTarget!,
        ))
        : undefined;
    const accessibilityLabel = [compact ? groupTitle : undefined, current.title, current.subtitle, current.detail]
        .filter((value): value is string => Boolean(value))
        .join(', ');
    const changeTarget = React.useCallback((change: () => void) => {
        const result = runGuardedNavigation(change);
        if (result !== true) {
            fireAndForget(result, { tag: 'MachineAdministrationTargetSelector.changeTarget' });
        }
    }, []);

    if (props.presentation === 'chip') {
        return <MachineTargetChip {...props} />;
    }

    return (
        <>
            <ItemGroup title={compact ? undefined : groupTitle}>
                <Item
                    testID={`${testIDPrefix}.current`}
                    title={current.title}
                    subtitle={[current.subtitle, current.detail].filter(Boolean).join(compact ? ' · ' : '\n')}
                    subtitleLines={0}
                    detail={canOpenPicker
                        ? t(current.gone ? 'settingsPlugins.targetSelection.chooseAnother' : 'common.change')
                        : undefined}
                    selected={!compact && current.selected}
                    mode={canOpenPicker ? 'interactive' : 'info'}
                    showChevron={canOpenPicker}
                    disabled={props.disabled}
                    accessibilityExpanded={canOpenPicker ? pickerOpen : undefined}
                    accessibilityHint={canOpenPicker
                        ? t(current.gone ? 'settingsPlugins.targetSelection.chooseAnother' : 'common.change')
                        : undefined}
                    onPress={canOpenPicker && !props.disabled ? () => setPickerOpen((open) => !open) : undefined}
                    accessibilityLabel={accessibilityLabel}
                />
                {props.selection.selectedTarget && (!compact || pickerOpen) ? (
                    <Item
                        testID={`${testIDPrefix}.clear`}
                        title={t('settingsPlugins.targetSelection.clear')}
                        accessibilityLabel={`${t('settingsPlugins.targetSelection.clear')}: ${groupTitle}`}
                        showChevron={false}
                        disabled={props.disabled}
                        onPress={() => changeTarget(() => {
                            props.selection.clearTarget();
                            setPickerOpen(false);
                        })}
                    />
                ) : null}
            </ItemGroup>
            {pickerOpen && groups.length > 0 ? (
                <ServerScopedMachineSelector
                    groups={groups}
                    selectedMachineId={props.selection.selectedTarget?.machineId ?? null}
                    selectedServerId={selectedRow?.serverId ?? null}
                    onSelect={(machine) => changeTarget(() => {
                        props.selection.selectTarget(machine.target);
                        setPickerOpen(false);
                    })}
                    resolveMachineAvailability={(machine) => {
                        const availability = props.resolveCandidateAvailability?.(machine.candidate)
                            ?? resolvePickerAvailability(machine);
                        return props.disabled ? { ...availability, selectable: false } : availability;
                    }}
                    resolveMachinePresentation={props.resolveCandidatePresentation
                        ? (machine) => props.resolveCandidatePresentation!(machine.candidate)
                        : undefined}
                    testIdPrefix={`${testIDPrefix}.picker`}
                />
            ) : null}
        </>
    );
}

const NO_PINNED_MACHINES: readonly MachineAdministrationPickerMachine[] = [];

/**
 * The machine scope as a filter: its current machine (name and presence) and the canonical machine
 * list as its chooser. A page header shows it as a chip; a picker (external sessions) passes it to
 * `SelectionList` `filters`. One owner decides what the scope says and which machines it offers.
 */
export function useMachineAdministrationTargetFilter(
    props: Omit<MachineAdministrationTargetSelectorProps, 'presentation'> & Readonly<{ filterId?: string }>,
): SelectionListFilter {
    const { theme } = useUnistyles();
    const testIDPrefix = props.testIDPrefix ?? 'machine-administration-target';
    const groupTitle = props.groupTitle ?? t('settingsProviders.detail.targetMachine');
    const current = presentCurrentTarget(
        props.selection.state,
        props.unselectedTitle,
        props.missingTargetTitle,
        props.missingTargetSubtitle,
        props.resolveCandidatePresentation,
        props.resolveCandidateAvailability,
        true,
    );
    const groups = buildPickerGroups(props.selection);
    const selectedRow = props.selection.selectedTarget
        ? props.selection.pickerRows.find((row) => machineAdministrationTargetsEqual(
            row.candidate.target,
            props.selection.selectedTarget!,
        ))
        : undefined;
    const hasTarget = props.selection.selectedTarget !== null && !current.gone;
    const presence = props.selection.state.kind === 'online' || props.selection.state.kind === 'offline'
        ? props.selection.state.kind
        : undefined;
    const changeTarget = React.useCallback((change: () => void) => {
        const result = runGuardedNavigation(change);
        if (result !== true) {
            fireAndForget(result, { tag: 'MachineAdministrationTargetSelector.changeTarget' });
        }
    }, []);
    const { selection, resolveCandidateAvailability, resolveCandidatePresentation } = props;
    const selectedServerId = selectedRow?.serverId ?? null;
    const canOpen = groups.length > 0 && props.disabled !== true;
    const renderPopoverContent = React.useCallback(({ close, maxHeight }: Readonly<{ close: () => void; maxHeight: number }>) => (
        <MachineTargetChipList
            groups={groups}
            selection={selection}
            selectedServerId={selectedServerId}
            resolveCandidateAvailability={resolveCandidateAvailability}
            resolveCandidatePresentation={resolveCandidatePresentation}
            testIDPrefix={testIDPrefix}
            maxHeight={maxHeight}
            onSelect={(machine) => changeTarget(() => {
                selection.selectTarget(machine.target);
                close();
            })}
        />
    ), [changeTarget, groups, resolveCandidateAvailability, resolveCandidatePresentation, selectedServerId, selection, testIDPrefix]);
    return {
        id: props.filterId ?? 'machine',
        label: groupTitle,
        valueLabel: current.title,
        icon: <Icon name="desktop" size={14} color={theme.colors.text.secondary} />,
        ...(hasTarget && presence ? { presence } : {}),
        muted: !hasTarget,
        ...(canOpen ? { renderPopoverContent } : {}),
        ...(props.chipOpen !== undefined ? { open: props.chipOpen } : {}),
        ...(props.onChipOpenChange ? { onOpenChange: props.onChipOpenChange } : {}),
        disabled: props.disabled,
        testID: `${testIDPrefix}.chip`,
    };
}

/**
 * The page-header form of the selector: the machine filter as a chip. It stays mounted in loading,
 * empty and error states because it is the control that recovers them.
 */
function MachineTargetChip(props: MachineAdministrationTargetSelectorProps) {
    const filter = useMachineAdministrationTargetFilter(props);
    return <SelectionListFilterChip filter={filter} />;
}

/**
 * The chip's popover body: the one machine list new session uses, with the launch-only concepts
 * (favorites, recents, CLI glyphs, pools, Temporary computer) left out. Administration keeps its
 * own availability decision and naming, and mounts only while the popover is open.
 */
function MachineTargetChipList(props: Readonly<{
    groups: ReturnType<typeof buildPickerGroups>;
    selection: MachineAdministrationTargetSelectionV1;
    selectedServerId: string | null;
    resolveCandidateAvailability: MachineAdministrationTargetSelectorProps['resolveCandidateAvailability'];
    resolveCandidatePresentation: MachineAdministrationTargetSelectorProps['resolveCandidatePresentation'];
    testIDPrefix: string;
    maxHeight: number;
    onSelect: (machine: MachineAdministrationPickerMachine) => void;
}>) {
    const { resolveCandidateAvailability, resolveCandidatePresentation } = props;
    const selectedTarget = props.selection.selectedTarget;
    const selectedMachine = React.useMemo(() => {
        if (!selectedTarget) return null;
        for (const group of props.groups) {
            const match = group.machines.find((machine) => machineAdministrationTargetsEqual(machine.target, selectedTarget));
            if (match) return match;
        }
        return null;
    }, [props.groups, selectedTarget]);
    const resolveMachineAvailability = React.useCallback(
        (machine: MachineAdministrationPickerMachine): MachineSelectionAvailability => (
            resolveCandidateAvailability?.(machine.candidate) ?? resolvePickerAvailability(machine)
        ),
        [resolveCandidateAvailability],
    );
    const resolveMachinePresentation = React.useMemo(() => (resolveCandidatePresentation
        ? (machine: MachineAdministrationPickerMachine) => resolveCandidatePresentation(machine.candidate)
        : undefined), [resolveCandidatePresentation]);
    return (
        <NewSessionMachineSelectionContent<MachineAdministrationPickerMachine>
            groups={props.groups}
            selectedMachine={selectedMachine}
            selectedServerId={props.selectedServerId}
            recentMachines={NO_PINNED_MACHINES}
            favoriteMachines={NO_PINNED_MACHINES}
            onSelectMachine={props.onSelect}
            onSelectScopedMachine={props.onSelect}
            resolveMachineAvailability={resolveMachineAvailability}
            resolveMachinePresentation={resolveMachinePresentation}
            showFavorites={false}
            showRecent={false}
            showSearch={false}
            showCliGlyphs={false}
            autoDetectCliGlyphs={false}
            testIdPrefix={`${props.testIDPrefix}.picker`}
            testID={`${props.testIDPrefix}.picker-list`}
            maxHeight={props.maxHeight}
        />
    );
}
