import * as React from 'react';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';

import type {
    ServerScopedMachineGroup,
    ServerScopedMachinePresentation,
} from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import { ServerScopedMachineSelector } from '@/components/sessions/new/components/ServerScopedMachineSelector';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';
import {
    composePluginMachineExecutionOriginV1,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginMachineExecutionOriginCandidateV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import {
    type PluginMachineExecutionOriginSelectionV1,
} from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';

type PresentedPluginOrigin = ServerScopedMachinePresentation & Readonly<{
    candidate: PluginMachineExecutionOriginCandidateV1;
    origin: PluginMachineExecutionOriginV1;
}>;

function exactOriginKey(origin: PluginMachineExecutionOriginV1): string {
    return [
        origin.serverIdentityId,
        origin.materializationRef.machineId,
        origin.materializationRef.materializationId,
        origin.materializationRef.pluginId,
    ].map((part) => `${part.length}:${part}`).join('|');
}

function exactOriginsEqual(
    left: PluginMachineExecutionOriginV1 | null,
    right: PluginMachineExecutionOriginV1,
): boolean {
    return left !== null && exactOriginKey(left) === exactOriginKey(right);
}

function resolveCandidatePresentationDetail(candidate: PluginMachineExecutionOriginCandidateV1): string {
    const version = `${t('common.version')} ${candidate.materialization.version}`;
    if (candidate.releaseContent === 'conflict') {
        return `${t('settingsPlugins.executionOriginReleaseContentConflict')} · ${version}`;
    }
    return isPluginMachineExecutionOriginCandidateSelectable(candidate)
        ? version
        : t('common.unavailable');
}

function buildOriginGroups(
    candidates: readonly PluginMachineExecutionOriginCandidateV1[],
): readonly ServerScopedMachineGroup<PresentedPluginOrigin>[] {
    const groups = new Map<string, PresentedPluginOrigin[]>();
    for (const candidate of candidates) {
        const materialization = candidate.materialization;
        const origin = composePluginMachineExecutionOriginV1(materialization);
        const rows = groups.get(materialization.serverIdentityId) ?? [];
        rows.push(Object.freeze({
            id: materialization.machineId,
            serverId: materialization.serverIdentityId,
            serverName: materialization.serverIdentityId,
            updatedAt: materialization.observedAt,
            active: isPluginMachineExecutionOriginCandidateSelectable(candidate),
            activeAt: materialization.observedAt,
            metadataVersion: 1,
            metadata: Object.freeze({
                displayName: materialization.machineId,
                host: materialization.machineId,
            }),
            candidate,
            origin,
        }));
        groups.set(materialization.serverIdentityId, rows);
    }
    return Object.freeze([...groups.entries()].map(([serverIdentityId, machines]) => Object.freeze({
        serverId: serverIdentityId,
        serverName: serverIdentityId,
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
): PluginMachineExecutionOriginPresentation {
    const selectedOrigin = selection.selectedOrigin
        ?? (selection.state.kind === 'selected' ? selection.state.origin : null);
    if (selectedOrigin) {
        const selectedCandidate = selection.candidates.find((candidate) => exactOriginsEqual(
            selectedOrigin,
            composePluginMachineExecutionOriginV1(candidate.materialization),
        ));
        return {
            title: selectedOrigin.materializationRef.machineId,
            subtitle: selectedOrigin.serverIdentityId,
            detail: selectedCandidate
                ? resolveCandidatePresentationDetail(selectedCandidate)
                : t('common.unavailable'),
            selected: true,
        };
    }
    if (selection.state.kind === 'conflict') {
        return {
            title: t('common.warning'),
            detail: selection.state.reasons.includes('content_conflict')
                ? t('settingsPlugins.executionOriginReleaseContentConflict')
                : t('common.unavailable'),
            selected: false,
        };
    }
    return {
        title: t('newSession.noMachineSelected'),
        detail: t('common.unavailable'),
        selected: false,
    };
}

export function PluginMachineExecutionOriginSelectorView(props: Readonly<{
    selection: PluginMachineExecutionOriginSelectionV1;
    testIDPrefix?: string;
}>) {
    const current = resolvePluginMachineExecutionOriginPresentation(props.selection);
    const groups = React.useMemo(
        () => buildOriginGroups(props.selection.candidates),
        [props.selection.candidates],
    );
    const selectedOrigin = props.selection.selectedOrigin
        ?? (props.selection.state.kind === 'selected' ? props.selection.state.origin : null);
    const currentTestID = props.testIDPrefix ? `${props.testIDPrefix}.current` : undefined;
    const clearTestID = props.testIDPrefix ? `${props.testIDPrefix}.clear` : undefined;

    return (
        <>
            <ItemGroup title={t('settingsProviders.detail.targetMachine')}>
                <Item
                    testID={currentTestID}
                    title={current.title}
                    subtitle={current.subtitle}
                    detail={current.detail}
                    selected={current.selected}
                    mode="info"
                    showChevron={false}
                />
                {props.selection.selectedOrigin ? (
                    <Item
                        testID={clearTestID}
                        title={t('common.remove')}
                        onPress={props.selection.clearOrigin}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>
            {groups.length > 0 ? (
                <ServerScopedMachineSelector
                    groups={groups}
                    selectedMachineId={selectedOrigin?.materializationRef.machineId ?? null}
                    selectedServerId={selectedOrigin?.serverIdentityId ?? null}
                    onSelect={(machine) => props.selection.selectOrigin(machine.origin)}
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
