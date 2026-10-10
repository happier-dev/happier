import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { ServerScopedMachineSelector } from '@/components/sessions/new/components/ServerScopedMachineSelector';
import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import { resolveMachineAdministrationTargetLabel, type MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import {
    getPluginExecutionOriginCandidateOrigin,
    getPluginExecutionOriginCandidateVersion,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginExecutionOriginCandidateV1,
    type PluginMachineOriginRejectionReasonV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import {
    type PluginExecutionOriginSelectionMutationResult,
    type PluginMachineExecutionOriginSelectionV1,
} from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

type PresentedPluginOrigin = ServerScopedMachinePresentation & Readonly<{
    candidate: PluginExecutionOriginCandidateV1;
    origin: PluginMachineExecutionOriginV1;
}>;

function exactOriginKey(origin: PluginMachineExecutionOriginV1): string {
    return JSON.stringify(origin);
}

function exactOriginsEqual(
    left: PluginMachineExecutionOriginV1 | null,
    right: PluginMachineExecutionOriginV1,
): boolean {
    return left !== null && arePluginMachineExecutionOriginsEqual(left, right);
}

function resolveCandidatePresentationDetail(candidate: PluginExecutionOriginCandidateV1): string {
    const version = `${t('common.version')} ${getPluginExecutionOriginCandidateVersion(candidate)}`;
    if (candidate.releaseContent === 'conflict') {
        return `${t('settingsPlugins.executionOriginReleaseContentConflict')} · ${version}`;
    }
    return isPluginMachineExecutionOriginCandidateSelectable(candidate)
        ? version
        : `${originReasonDetail(candidate.validation.kind === 'rejected' ? candidate.validation.reason : 'unknown')} · ${version}`;
}

function originReasonDetail(reason: PluginMachineOriginRejectionReasonV1 | 'no_materialization' | 'different_versions'): string {
    switch (reason) {
        case 'content_conflict': return t('settingsPlugins.executionOriginReleaseContentConflict');
        case 'disabled': return t('settingsPlugins.machineMatrix.state.disabled');
        case 'untrusted': return t('settingsPlugins.machineMatrix.state.untrusted');
        case 'incompatible': return t('settingsPlugins.machineMatrix.state.incompatible');
        case 'machine_local': return t('settingsPlugins.machineMatrix.state.localOnly');
        case 'offline': return t('settingsProviders.detail.machineOffline');
        case 'stale': return t('settingsPlugins.machineMatrix.state.staleOffline');
        case 'missing': return t('settingsPlugins.targetSelection.missing');
        case 'replaced': return t('settingsPlugins.targetSelection.replaced');
        case 'revoked': return t('settingsPlugins.targetSelection.revoked');
        case 'plugin_mismatch': return t('settingsPlugins.targetSelection.pluginMismatch');
        case 'no_materialization': return t('settingsPlugins.targetSelection.noMaterialization');
        case 'different_versions': return t('settingsPlugins.targetSelection.differentVersions');
        case 'unknown': return t('settingsPlugins.targetSelection.unknown');
    }
}

function buildOriginGroups(
    candidates: readonly PluginExecutionOriginCandidateV1[],
    machineCandidates: readonly MachineAdministrationCandidateV1[],
): readonly ServerScopedMachineGroup<PresentedPluginOrigin>[] {
    const groups = new Map<string, PresentedPluginOrigin[]>();
    for (const candidate of candidates) {
        const origin = getPluginExecutionOriginCandidateOrigin(candidate);
        const ref = getPluginMachineExecutionOriginRef(origin);
        const labels = resolveMachineAdministrationTargetLabel({ target: { serverIdentityId: origin.serverIdentityId, machineId: ref.machineId }, candidates: machineCandidates })!;
        const observedAt = 'materialization' in candidate ? candidate.materialization.observedAt : 0;
        const rows = groups.get(origin.serverIdentityId) ?? [];
        rows.push(Object.freeze({
            id: ref.machineId,
            serverId: origin.serverIdentityId,
            serverName: labels.server,
            updatedAt: observedAt,
            active: isPluginMachineExecutionOriginCandidateSelectable(candidate),
            activeAt: observedAt,
            metadataVersion: 1,
            metadata: Object.freeze({
                displayName: labels.machine,
                host: ref.machineId,
            }),
            candidate,
            origin,
        }));
        groups.set(origin.serverIdentityId, rows);
    }
    return Object.freeze([...groups.entries()].map(([serverIdentityId, machines]) => Object.freeze({
        serverId: serverIdentityId,
        serverName: machines[0]!.serverName,
        machines,
        loading: false,
        signedOut: false,
    })));
}

export type PluginMachineExecutionOriginPresentation = Readonly<{
    title: string;
    subtitle?: string;
    detail: string;
    selected: boolean;
}>;

/** The one user-facing presentation for the exact persisted plugin origin. */
export function resolvePluginMachineExecutionOriginPresentation(
    selection: PluginMachineExecutionOriginSelectionV1,
    machineCandidates: readonly MachineAdministrationCandidateV1[] = [],
): PluginMachineExecutionOriginPresentation {
    const selectedOrigin = selection.selectedOrigin
        ?? (selection.state.kind === 'selected' ? selection.state.origin : null);
    if (selectedOrigin) {
        const selectedRef = getPluginMachineExecutionOriginRef(selectedOrigin);
        const labels = resolveMachineAdministrationTargetLabel({ target: { serverIdentityId: selectedOrigin.serverIdentityId, machineId: selectedRef.machineId }, candidates: machineCandidates })!;
        const selectedCandidate = selection.candidates.find((candidate) => exactOriginsEqual(
            selectedOrigin,
            getPluginExecutionOriginCandidateOrigin(candidate),
        ));
        return {
            title: labels.machine,
            subtitle: labels.machine === selectedRef.machineId
                ? labels.server
                : [labels.server, selectedRef.machineId].join(' · '),
            detail: selection.state.kind === 'unavailable'
                ? selection.state.reasons.map(originReasonDetail).join(' · ')
                : selectedCandidate
                ? resolveCandidatePresentationDetail(selectedCandidate)
                : t('common.unavailable'),
            selected: true,
        };
    }
    if (selection.state.kind === 'conflict') {
        return {
            title: t('common.warning'),
            detail: selection.state.reasons.map(originReasonDetail).join(' · '),
            selected: false,
        };
    }
    // Nothing chosen: say so, and whether there is anything to choose from (never the New Session copy).
    return {
        title: selection.state.kind === 'unavailable'
            ? t('settingsPlugins.surfaces.runOnNoneAvailable')
            : t('settingsPlugins.surfaces.runOnNoneChosen'),
        detail: selection.state.kind === 'unavailable'
            ? selection.state.reasons.map(originReasonDetail).join(' · ')
            : t('settingsPlugins.targetSelection.selectionRequired'),
        selected: false,
    };
}

export function PluginMachineExecutionOriginSelectorView(props: Readonly<{
    selection: PluginMachineExecutionOriginSelectionV1;
    testIDPrefix?: string;
    /** Contextual label for the machine scope this selector presents. */
    groupTitle?: string;
    presentation?: 'section' | 'chip';
    machineCandidates?: readonly MachineAdministrationCandidateV1[];
}>) {
    const { theme } = useUnistyles();
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const [settlementError, setSettlementError] = React.useState<string | null>(null);
    const settleSelection = React.useCallback(async (
        mutation: Promise<PluginExecutionOriginSelectionMutationResult>,
    ) => {
        try {
            const result = await mutation;
            if (result.status === 'applied') {
                setSettlementError(null);
                setPickerOpen(false);
                return true;
            }
            setSettlementError(result.status === 'outcomeUnknown'
                ? t('settingsProviders.errors.mutationOutcomeUnknownDescription')
                : t('settingsPlugins.genericSettingsSaveError'));
        } catch {
            setSettlementError(t('settingsPlugins.genericSettingsSaveError'));
        }
        return false;
    }, []);
    const machineCandidates = props.machineCandidates ?? props.selection.machineCandidates;
    const current = resolvePluginMachineExecutionOriginPresentation(props.selection, machineCandidates);
    const groups = React.useMemo(
        () => buildOriginGroups(props.selection.candidates, machineCandidates ?? []),
        [props.selection.candidates, machineCandidates],
    );
    const selectedOrigin = props.selection.selectedOrigin
        ?? (props.selection.state.kind === 'selected' ? props.selection.state.origin : null);
    const currentTestID = props.testIDPrefix ? `${props.testIDPrefix}.current` : undefined;
    const clearTestID = props.testIDPrefix ? `${props.testIDPrefix}.clear` : undefined;
    const groupTitle = props.groupTitle ?? t('settingsProviders.detail.targetMachine');
    const clearAccessibilityScope = props.groupTitle ?? t('settingsPlugins.executionOriginTitle');

    if (props.presentation === 'chip') {
        return <SelectionListFilterChip filter={{
            id: 'plugin-execution',
            label: groupTitle,
            valueLabel: current.title,
            icon: <Icon name="desktop" size={14} color={theme.colors.text.secondary} />,
            muted: !current.selected,
            testID: props.testIDPrefix ? `${props.testIDPrefix}.chip` : undefined,
            ...(groups.length > 0 ? {
                renderPopoverContent: ({ close, maxHeight }) => (
                    <>
                    <NewSessionMachineSelectionContent<PresentedPluginOrigin>
                        groups={groups}
                        selectedMachine={groups.flatMap((group) => group.machines).find((machine) => exactOriginsEqual(selectedOrigin, machine.origin)) ?? null}
                        selectedServerId={selectedOrigin?.serverIdentityId ?? null}
                        recentMachines={[]}
                        favoriteMachines={[]}
                        onSelectMachine={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)).then((applied) => { if (applied) close(); }); }}
                        onSelectScopedMachine={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)).then((applied) => { if (applied) close(); }); }}
                        resolveMachineAvailability={(machine) => ({
                            detail: resolveCandidatePresentationDetail(machine.candidate),
                            selectable: isPluginMachineExecutionOriginCandidateSelectable(machine.candidate),
                        })}
                        showFavorites={false}
                        showRecent={false}
                        showSearch={false}
                        showCliGlyphs={false}
                        autoDetectCliGlyphs={false}
                        testIdPrefix={props.testIDPrefix ? `${props.testIDPrefix}.picker` : undefined}
                        testID={props.testIDPrefix ? `${props.testIDPrefix}.picker-list` : undefined}
                        maxHeight={maxHeight}
                    />
                    {props.selection.selectedOrigin ? <Item
                        testID={clearTestID}
                        title={t('settingsPlugins.targetSelection.clear')}
                        accessibilityLabel={`${t('settingsPlugins.targetSelection.clear')}: ${clearAccessibilityScope}`}
                        onPress={() => { void settleSelection(props.selection.clearOrigin()).then((applied) => { if (applied) close(); }); }}
                        showChevron={false}
                    /> : null}
                    {settlementError ? <Item title={settlementError} mode="info" showChevron={false} /> : null}
                    </>
                ),
            } : {}),
        }} />;
    }

    return (
        <>
            <ItemGroup title={groupTitle}>
                <Item
                    testID={currentTestID}
                    title={current.title}
                    subtitle={[current.subtitle, current.detail].filter(Boolean).join('\n')}
                    subtitleLines={0}
                    detail={groups.length > 0 ? t('common.change') : undefined}
                    selected={current.selected}
                    mode={groups.length > 0 ? 'interactive' : 'info'}
                    showChevron={groups.length > 0}
                    accessibilityExpanded={groups.length > 0 ? pickerOpen : undefined}
                    accessibilityHint={groups.length > 0 ? t('common.change') : undefined}
                    onPress={groups.length > 0 ? () => setPickerOpen((open) => !open) : undefined}
                />
                {props.selection.selectedOrigin ? (
                    <Item
                        testID={clearTestID}
                        title={t('settingsPlugins.targetSelection.clear')}
                        accessibilityLabel={`${t('settingsPlugins.targetSelection.clear')}: ${clearAccessibilityScope}`}
                        onPress={() => { void settleSelection(props.selection.clearOrigin()); }}
                        showChevron={false}
                    />
                ) : null}
                {settlementError ? (
                    <Item
                        testID={props.testIDPrefix ? `${props.testIDPrefix}.settlementError` : undefined}
                        title={settlementError}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            {pickerOpen && groups.length > 0 ? (
                <ServerScopedMachineSelector
                    groups={groups}
                    selectedMachineId={selectedOrigin ? getPluginMachineExecutionOriginRef(selectedOrigin).machineId : null}
                    selectedServerId={selectedOrigin?.serverIdentityId ?? null}
                    onSelect={(machine) => { void settleSelection(props.selection.selectOrigin(machine.origin)); }}
                    resolveMachineAvailability={(machine) => ({
                        detail: resolveCandidatePresentationDetail(machine.candidate),
                        selectable: isPluginMachineExecutionOriginCandidateSelectable(machine.candidate),
                    })}
                    getMachineKey={(machine) => exactOriginKey(machine.origin)}
                    isMachineSelected={(machine) => exactOriginsEqual(selectedOrigin, machine.origin)}
                    testIdPrefix={props.testIDPrefix}
                />
            ) : null}
        </>
    );
}
