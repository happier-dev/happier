import * as React from 'react';
import { readExternalSessionsSettingsV1 } from '@happier-dev/protocol/sessions/external/followLifecycleV1';
import { readExternalSessionFollowStatusV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';

import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { EXTERNAL_SESSIONS_SETTINGS } from '@/components/settings/externalSessions/externalSessionsSettings';
import { Modal } from '@/modal';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import {
    readExternalSessionFollowPolicy,
} from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { setExternalSessionFollowPolicy } from '@/components/sessions/external/follow/setExternalSessionFollowPolicy';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    useMachineAdministrationTargetSelection,
} from '@/sync/domains/machines/administration/useTargetSelection';
import { isMachineAdministrationExecutionTargetCurrent } from '@/sync/domains/machines/administration/operationCurrentness';
import { useActiveServerAccountScope, useAllSessions, useSetting, useActiveMachineFacts } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import type { SessionRecordingVisibility } from '@/sync/domains/session/listing/recordingPrivacy';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { resolveMachinePickerPresence, type MachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { supportsExternalSessionBackgroundFollow } from '@/components/sessions/external/browse/resolveExternalSessionBrowseSourceOptions';
import {
    ExternalSessionsIntegrationSection,
    type ExternalSessionsSettingsSupplementalRow,
} from './ExternalSessionsIntegrationSection';
import { useExternalSessionsIntegrationController } from './externalSessionsIntegrationController';
import { useExternalSessionsAutoLinkSources } from './useExternalSessionsAutoLinkSources';
import { useRestartFollowSetting } from './useRestartFollowSetting';
import type {
    ExternalSessionsAutoLinkSourceDescriptor,
    ExternalSessionsIntegrationDescriptor,
    ExternalSessionsIntegrationOperations,
} from './externalSessionsIntegrationModel';

type FollowRow = Readonly<{
    session: Session;
    title: string;
    enabled: boolean;
    status:
        | 'disabled'
        | 'paused'
        | 'reacquiring'
        | 'active'
        | 'error'
        | 'machine_offline'
        | 'unsupported'
        | 'unknown';
    canChange: boolean;
}>;

function resolveFollowStatusSubtitle(status: FollowRow['status']): string {
    switch (status) {
        case 'disabled':
            return t('externalSessions.followStatusDisabled');
        case 'paused':
            return t('externalSessions.followStatusPaused');
        case 'reacquiring':
            return t('externalSessions.followStatusReacquiring');
        case 'active':
            return t('externalSessions.followStatusActive');
        case 'error':
            return t('externalSessions.followStatusError');
        case 'machine_offline':
            return t('externalSessions.followStatusMachineOffline');
        case 'unsupported':
            return t('externalSessions.followStatusUnsupported');
        case 'unknown':
            return t('externalSessions.followStatusUnknown');
    }
}

function buildFollowRows(
    sessions: readonly Session[],
    machinePresenceById: ReadonlyMap<string, Readonly<{ presence: MachinePickerPresence; canChange: boolean }>>,
    isRecordingVisible: SessionRecordingVisibility,
): FollowRow[] {
    const rows: FollowRow[] = [];
    for (const session of sessions) {
        const metadata = readSessionOwnerMetadataView(session);
        const link = readExternalSessionLink(metadata);
        if (!link) continue;
        const enabled = readExternalSessionFollowPolicy(metadata) === 'background_follow';
        const machine = machinePresenceById.get(link.machineId);
        const status = machine?.presence.status === 'offline'
            ? 'machine_offline'
            : machine?.presence.status !== 'online' ? 'unknown'
                : readExternalSessionFollowStatusV1(link.followStatusV1)?.status ?? 'unknown';
        const title = isRecordingVisible({ sessionId: session.id, serverId: session.serverId }) ? getSessionName(session) : t('session.untitled');
        rows.push({
            session,
            title,
            enabled,
            status,
            canChange: machine?.canChange === true,
        });
    }
    return rows;
}

const ExternalSessionFollowItem = React.memo(function ExternalSessionFollowItem(props: Readonly<{
    row: FollowRow;
    pending: boolean;
    mutationStatus: 'error' | 'unsupported' | undefined;
    onSetEnabled: (row: FollowRow, enabled: boolean) => Promise<void>;
    /**
     * Owned by the enclosing ItemGroup, which is the only place that knows whether this
     * row ends the group or only ends one virtualized chunk of it. Forwarding it is not
     * optional: `Item` defaults to drawing a divider, so a wrapper that swallows the prop
     * draws one under the group's true last row and loses the group's authority entirely.
     */
    showDivider?: boolean;
}>) {
    const link = readExternalSessionLink(readSessionOwnerMetadataView(props.row.session));
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: link?.machineId ?? null,
        serverId: props.row.session.serverId ?? null,
        enabled: link !== null,
        sections: DAEMON_AGENT_CATALOG_SECTIONS,
    });
    const capabilityPhase = daemonMergedProjection.phase;
    const supportsBackgroundFollow = link !== null
        && capabilityPhase === 'ready'
        && supportsExternalSessionBackgroundFollow({
            providerId: link.agentId,
            source: link.source,
            projection: daemonMergedProjection.inputs?.pluginProjectionV2,
        });

    if (capabilityPhase === 'ready' && !supportsBackgroundFollow) {
        return (
            <Item
                testID={`settings-external-sessions-follow-item-${props.row.session.id}`}
                mode="info"
                {...(props.showDivider === undefined ? {} : { showDivider: props.showDivider })}
                title={props.row.title}
                subtitle={resolveFollowStatusSubtitle('unsupported')}
                showChevron={false}
            />
        );
    }

    const status = props.mutationStatus ?? props.row.status;
    // Until the current trusted plugin generation answers, the row keeps the
    // stored policy as last-known information but must not advertise a
    // capability nobody has declared yet: fail closed, truthfully. A pending
    // projection shows its in-flight state; a failed projection says the
    // status cannot be verified instead of leaving an enabled-looking control.
    const capabilityPending = capabilityPhase === 'loading' || capabilityPhase === 'idle';
    const capabilityUnavailable = capabilityPhase === 'error' || capabilityPhase === 'unsupported';
    const disabled = props.pending
        || capabilityPending
        || capabilityUnavailable
        || !props.row.canChange
        || (!props.row.enabled && props.mutationStatus === 'unsupported');
    return (
        <Item
            testID={`settings-external-sessions-follow-item-${props.row.session.id}`}
            {...(props.showDivider === undefined ? {} : { showDivider: props.showDivider })}
            title={props.row.title}
            subtitle={capabilityUnavailable ? resolveFollowStatusSubtitle('unknown') : resolveFollowStatusSubtitle(status)}
            loading={props.pending || capabilityPending}
            disabled={disabled}
            rightElement={(
                <Switch
                    testID={`settings-external-sessions-follow-toggle-${props.row.session.id}`}
                    accessibilityLabel={props.row.title}
                    accessibilityHint={t('externalSessions.settingsFollowToggleHint')}
                    value={props.row.enabled}
                    disabled={disabled}
                    onValueChange={(enabled) => {
                        if (disabled) return;
                        void props.onSetEnabled(props.row, enabled);
                    }}
                />
            )}
            rightElementOutsidePressable
            showChevron={false}
            onPress={() => {
                if (disabled) return;
                void props.onSetEnabled(props.row, !props.row.enabled);
            }}
        />
    );
});

export type ExternalSessionsSettingsViewProps = Readonly<{
    integrationInventoryEnabled?: boolean;
    integrations?: readonly ExternalSessionsIntegrationDescriptor[] | null;
    autoLinkSources?: readonly ExternalSessionsAutoLinkSourceDescriptor[] | null;
    integrationOperations?: ExternalSessionsIntegrationOperations | null;
}>;

export const ExternalSessionsSettingsView = React.memo(function ExternalSessionsSettingsView(
    props: ExternalSessionsSettingsViewProps,
) {
    const machines = useActiveMachineFacts();
    const accountScope = useActiveServerAccountScope();
    const followApproval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([accountScope?.serverId ?? null, accountScope?.accountId ?? null]),
        serverId: accountScope?.serverId ?? '', onExecuted: () => {},
    });
    const reachabilityRevision = useMachineReachabilityRevision();
    const nowMs = useMachinePresenceNowMs(machines);
    const sessions = useAllSessions();
    const isRecordingVisible = useSessionRecordingVisibility();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const rawSettings = useSetting('externalSessionsSettingsV1');
    const expectedSettingsScope = useAccountSettingsScope();
    const settings = readExternalSessionsSettingsV1(rawSettings) ?? {
        v: 1 as const,
        keepPassivelyFollowingAfterRestart: false,
        autoLinkSourcePolicies: [],
    };
    const machinePresenceById = React.useMemo(
        () => new Map(machines.map((machine) => [machine.id, {
            presence: resolveMachinePickerPresence(machine, nowMs, accountScope),
            canChange: isMachineSelectableForFleet(accountScope, machine, nowMs),
        }])),
        [machines, accountScope, reachabilityRevision, nowMs],
    );
    const rows = React.useMemo(
        () => buildFollowRows(sessions, machinePresenceById, isRecordingVisible),
        [machinePresenceById, sessions, isRecordingVisible],
    );
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.externalSessions,
    );
    const executionTarget = administrationTargetSelection.resolveExecutionTarget();
    const isExecutionTargetCurrent = React.useCallback(() => {
        if (!executionTarget) return false;
        return isMachineAdministrationExecutionTargetCurrent({
            expectedTarget: executionTarget,
            resolveCurrentTarget: administrationTargetSelection.resolveExecutionTarget,
        });
    }, [administrationTargetSelection.resolveExecutionTarget, executionTarget]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: executionTarget?.machine.id ?? null,
        serverId: executionTarget?.serverId ?? null,
        enabled: executionTarget !== null,
        sections: DAEMON_AGENT_CATALOG_SECTIONS,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.phase === 'ready'
        ? daemonMergedProjection.inputs
        : null;
    const projectedExternalSessionAgents = React.useMemo(() => {
        const pluginProjection = daemonMergedProjectionInputs?.pluginProjectionV2;
        if (!pluginProjection) return [];
        const enabledAgentIds = Object.keys(pluginProjection.agentsById);
        return Object.entries(pluginProjection.agentsById).flatMap(([agentId, entry]) => {
            const externalSessions = entry.externalSessions;
            if (!externalSessions || externalSessions.generation !== pluginProjection.generation) {
                return [];
            }
            const projection = resolveAgentCatalogProjection(agentId, {
                enabledAgentIds,
                backendEnabledByTargetKey,
                mergedProviderProjectionById:
                    daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
                mergedBackendProjectionById:
                    daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            });
            return [{
                agent: externalSessions.agent,
                agentTitle: projection.title,
            }];
        });
    }, [
        backendEnabledByTargetKey,
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        daemonMergedProjectionInputs?.pluginProjectionV2,
    ]);
    const persistedAutoLinkSources = useExternalSessionsAutoLinkSources({
        rawSettings,
        knownAgents: projectedExternalSessionAgents,
    });
    const integrationController = useExternalSessionsIntegrationController({
        machineId: executionTarget?.machine.id ?? null,
        serverId: executionTarget?.serverId ?? null,
        projectionGeneration: `${
            daemonMergedProjectionInputs?.pluginProjectionV2?.generation ?? 'unavailable'
        }:${executionTarget?.machine.daemonStateVersion ?? 0}`,
        agent: null,
        knownAgents: projectedExternalSessionAgents,
        // The inventory is read per projection generation. Reading it before the target's projection
        // settles would read once as `unavailable` and again when the projection arrives.
        enabled: props.integrationInventoryEnabled === true
            && props.integrations === undefined
            && executionTarget !== null
            && daemonMergedProjection.phase !== 'idle'
            && daemonMergedProjection.phase !== 'loading',
        isExecutionTargetCurrent,
    });
    const hasActiveFollowPolicy = rows.some((row) => row.enabled);
    const pendingSessionIdsRef = React.useRef(new Set<string>());
    const presentationActive = useLayoutPresentationActive();
    const followControllerRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        const controller = new AbortController();
        followControllerRef.current = controller;
        if (!presentationActive) controller.abort();
        pendingSessionIdsRef.current.clear();
        setPendingSessionIds(new Set());
        return () => controller.abort();
    }, [presentationActive, expectedSettingsScope]);
    const [pendingSessionIds, setPendingSessionIds] = React.useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const [mutationStatusBySessionId, setMutationStatusBySessionId] = React.useState<
        ReadonlyMap<string, 'error' | 'unsupported'>
    >(() => new Map());
    const { pending: restartFollowMutationPending, setEnabled: setRestartFollowEnabled } = useRestartFollowSetting();

    const setSessionFollowEnabled = React.useCallback(async (row: FollowRow, enabled: boolean) => {
        const signal = followControllerRef.current?.signal;
        if (!signal || signal.aborted) return;
        const link = readExternalSessionLink(readSessionOwnerMetadataView(row.session));
        if (
            !link
            || !row.canChange
            || (!row.enabled && mutationStatusBySessionId.get(row.session.id) === 'unsupported')
            || pendingSessionIdsRef.current.has(row.session.id)
        ) return;

        pendingSessionIdsRef.current.add(row.session.id);
        setPendingSessionIds((current) => {
            const next = new Set(current);
            next.add(row.session.id);
            return next;
        });
        try {
            // One shared operation owner with the session header action. It
            // fences the settlement on the exact link identity and the active
            // Account lifetime, so a stale settlement never publishes into a
            // successor Account or a relinked session; only a current outcome
            // is allowed to touch this surface's state.
            const outcome = await setExternalSessionFollowPolicy({
                sessionId: row.session.id,
                serverId: row.session.serverId ?? null,
                link,
                policy: enabled ? 'background_follow' : 'attached_only',
                registerApproval: followApproval.requestApproval,
                signal,
            });
            if (outcome.kind === 'stale') return;
            if (outcome.kind !== 'applied') {
                const mutationStatus = outcome.kind === 'refused' && outcome.reason === 'unsupported'
                    ? 'unsupported'
                    : 'error';
                setMutationStatusBySessionId((current) => {
                    const next = new Map(current);
                    next.set(row.session.id, mutationStatus);
                    return next;
                });
                await Modal.alert(
                    t('common.error'),
                    t('externalSessions.followUpdateFailed'),
                );
                return;
            }
            setMutationStatusBySessionId((current) => {
                if (!current.has(row.session.id)) return current;
                const next = new Map(current);
                next.delete(row.session.id);
                return next;
            });
        } finally {
            if (signal.aborted) return;
            pendingSessionIdsRef.current.delete(row.session.id);
            setPendingSessionIds((current) => {
                if (!current.has(row.session.id)) return current;
                const next = new Set(current);
                next.delete(row.session.id);
                return next;
            });
        }
    }, [followApproval.requestApproval, mutationStatusBySessionId]);

    const supplementalRows = React.useMemo<readonly ExternalSessionsSettingsSupplementalRow[]>(() => {
        const result: ExternalSessionsSettingsSupplementalRow[] = [{
            key: 'follow-policy',
            render: () => (
                <ItemGroup
                    title={t('externalSessions.settingsFollowGroupTitle')}
                    description={t('externalSessions.settingsRestoreFooter')}
                >
                    <SettingRow
                        testID="settings-external-sessions-restore-item"
                        setting={EXTERNAL_SESSIONS_SETTINGS.settings.keepFollowingAfterRestart}
                        subtitle={settings.keepPassivelyFollowingAfterRestart
                            ? t('externalSessions.settingsRestoreEnabledSubtitle')
                            : t('externalSessions.settingsRestoreDisabledSubtitle')}
                        rightElement={(
                            <Switch
                                testID="settings-external-sessions-restore-toggle"
                                accessibilityLabel={t('externalSessions.settingsRestoreTitle')}
                                value={settings.keepPassivelyFollowingAfterRestart}
                                disabled={restartFollowMutationPending}
                                onValueChange={setRestartFollowEnabled}
                            />
                        )}
                        rightElementOutsidePressable
                        loading={restartFollowMutationPending}
                        disabled={restartFollowMutationPending}
                        showChevron={false}
                        onPress={() => setRestartFollowEnabled(!settings.keepPassivelyFollowingAfterRestart)}
                    />
                    <Item
                        testID="settings-external-sessions-notifications-info"
                        mode="info"
                        title={t('externalSessions.settingsNotificationsTitle')}
                        subtitle={hasActiveFollowPolicy
                            ? t('externalSessions.settingsNotificationsActiveSubtitle')
                            : t('externalSessions.settingsNotificationsInactiveSubtitle')}
                        showChevron={false}
                    />
                </ItemGroup>
            ),
        }];

        const followChunkSize = 12;
        for (let offset = 0; offset < Math.max(rows.length, 1); offset += followChunkSize) {
            const isFirst = offset === 0;
            const isLast = offset + followChunkSize >= rows.length;
            const chunk = rows.slice(offset, offset + followChunkSize);
            result.push({
                key: `active-follows:${offset}`,
                render: () => (
                    <ItemGroup
                        title={isFirst ? t('externalSessions.settingsActiveFollowsGroupTitle') : undefined}
                        description={isFirst ? t('externalSessions.settingsActiveFollowsFooter') : undefined}
                        virtualizedSegment={{ first: isFirst, last: isLast }}
                    >
                        {chunk.length === 0 ? (
                            <Item
                                testID="settings-external-sessions-follow-empty"
                                mode="info"
                                title={t('externalSessions.settingsActiveFollowsEmptyTitle')}
                                subtitle={t('externalSessions.settingsActiveFollowsEmptySubtitle')}
                                showChevron={false}
                            />
                        ) : chunk.map((row) => (
                            <ExternalSessionFollowItem
                                key={row.session.id}
                                row={row}
                                pending={pendingSessionIds.has(row.session.id)}
                                mutationStatus={mutationStatusBySessionId.get(row.session.id)}
                                onSetEnabled={setSessionFollowEnabled}
                            />
                        ))}
                    </ItemGroup>
                ),
            });
        }

        result.push({
            key: 'safety',
            render: () => (
                <ItemGroup title={t('externalSessions.settingsSafetyGroupTitle')}>
                    <Item
                        testID="settings-external-sessions-passive-info"
                        mode="info"
                        title={t('externalSessions.settingsPassiveTitle')}
                        subtitle={t('externalSessions.settingsPassiveSubtitle')}
                        showChevron={false}
                    />
                </ItemGroup>
            ),
        });
        return result;
    }, [
        hasActiveFollowPolicy,
        mutationStatusBySessionId,
        pendingSessionIds,
        restartFollowMutationPending,
        rows,
        setRestartFollowEnabled,
        setSessionFollowEnabled,
        settings.keepPassivelyFollowingAfterRestart,
    ]);

    return (
        <ExternalSessionsIntegrationSection
            virtualized
            virtualizedHeader={(
                <SettingsPageHeader
                    description={t('externalSessions.settingsEntrySubtitle')}
                    actions={(
                        <MachineAdministrationTargetSelector
                            selection={administrationTargetSelection}
                            testIDPrefix="settings-external-sessions-target"
                            presentation="chip"
                        />
                    )}
                />
            )}
            integrations={props.integrations === undefined
                ? integrationController.integrations
                : props.integrations}
            autoLinkSources={props.autoLinkSources === undefined
                ? persistedAutoLinkSources
                : props.autoLinkSources}
            machineId={executionTarget?.machine.id ?? null}
            agent={null}
            operations={props.integrationOperations === undefined
                ? integrationController.operations
                : props.integrationOperations}
            inventoryState={props.integrations === undefined
                ? integrationController.inventoryState
                : undefined}
            onRetryInventory={props.integrations === undefined
                ? integrationController.retryInventory
                : null}
            hasMoreInventory={props.integrations === undefined
                ? integrationController.hasMoreInventory
                : false}
            loadingMoreInventory={props.integrations === undefined
                ? integrationController.loadingMoreInventory
                : false}
            onLoadMoreInventory={props.integrations === undefined
                ? integrationController.loadMoreInventory
                : null}
            supplementalRows={supplementalRows}
        />
    );
});

export default ExternalSessionsSettingsView;
