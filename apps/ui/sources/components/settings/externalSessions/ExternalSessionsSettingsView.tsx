import * as React from 'react';
import {
    patchExternalSessionsSettingsV1,
    readExternalSessionFollowStatusV1,
    readExternalSessionsSettingsV1,
} from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { ContextBar } from '@/components/contextBar/ContextBar';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useContextBarSelection } from '@/components/contextBar/useContextBarSelection';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import {
    readExternalSessionFollowPolicy,
    updateMetadataWithExternalSessionFollowPolicy,
} from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { useAllMachines, useAllSessions, useSetting, useSettings } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { machineExternalSessionFollowPolicySet } from '@/sync/ops/machineExternalSessions';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { ExternalSessionsIntegrationSection } from './ExternalSessionsIntegrationSection';
import { useExternalSessionsIntegrationController } from './externalSessionsIntegrationController';
import { useExternalSessionsAutoLinkSources } from './useExternalSessionsAutoLinkSources';
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
    machineOnlineById: ReadonlyMap<string, boolean>,
): FollowRow[] {
    const rows: FollowRow[] = [];
    for (const session of sessions) {
        const metadata = readSessionOwnerMetadataView(session);
        const link = readExternalSessionLink(metadata);
        if (!link) continue;
        const enabled = readExternalSessionFollowPolicy(metadata) === 'background_follow';
        const machineOnline = machineOnlineById.get(link.machineId);
        const status = machineOnline === false
            ? 'machine_offline'
            : readExternalSessionFollowStatusV1(link.followStatusV1)?.status ?? 'unknown';
        const title = readSessionDisplayTitleField(session).value
            ?? metadata?.name
            ?? link.remoteSessionId;
        rows.push({
            session,
            title,
            enabled,
            status,
            canChange: machineOnline !== false,
        });
    }
    return rows;
}

export type ExternalSessionsSettingsViewProps = Readonly<{
    initialMachineId?: string | null;
    integrationInventoryEnabled?: boolean;
    integrations?: readonly ExternalSessionsIntegrationDescriptor[] | null;
    autoLinkSources?: readonly ExternalSessionsAutoLinkSourceDescriptor[] | null;
    integrationOperations?: ExternalSessionsIntegrationOperations | null;
}>;

export const ExternalSessionsSettingsView = React.memo(function ExternalSessionsSettingsView(
    props: ExternalSessionsSettingsViewProps,
) {
    const { theme } = useUnistyles();
    const machines = useAllMachines();
    const sessions = useAllSessions();
    const accountSettings = useSettings();
    const rawSettings = useSetting('externalSessionsSettingsV1');
    const settings = readExternalSessionsSettingsV1(rawSettings) ?? {
        v: 1 as const,
        keepPassivelyFollowingAfterRestart: false,
        autoLinkSourcePolicies: [],
    };
    const machineOnlineById = React.useMemo(
        () => new Map(machines.map((machine) => [machine.id, isMachineOnline(machine)])),
        [machines],
    );
    const rows = React.useMemo(
        () => buildFollowRows(sessions, machineOnlineById),
        [machineOnlineById, sessions],
    );
    const selectableMachines = React.useMemo(
        () => machines.filter((machine) => machine.revokedAt == null),
        [machines],
    );
    const defaultMachineId = selectableMachines.find(isMachineOnline)?.id
        ?? selectableMachines[0]?.id
        ?? null;
    const {
        machineId: selectedMachineId,
        setMachineId: setSelectedMachineId,
    } = useContextBarSelection({
        selectionKey: 'externalSessionsSettings',
        defaultMachineId,
        initialMachineId: props.initialMachineId,
    });
    const selectedMachine = selectableMachines.find(
        (machine) => machine.id === selectedMachineId,
    ) ?? selectableMachines[0] ?? null;
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: selectedMachine?.id ?? null,
        serverId: null,
        enabled: selectedMachine !== null,
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
                backendEnabledByTargetKey: accountSettings.backendEnabledByTargetKey,
                acpCatalogSettingsV1: accountSettings.acpCatalogSettingsV1,
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
        accountSettings.acpCatalogSettingsV1,
        accountSettings.backendEnabledByTargetKey,
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        daemonMergedProjectionInputs?.pluginProjectionV2,
    ]);
    const persistedAutoLinkSources = useExternalSessionsAutoLinkSources({
        rawSettings,
        knownAgents: projectedExternalSessionAgents,
    });
    const integrationController = useExternalSessionsIntegrationController({
        machineId: selectedMachine?.id ?? null,
        projectionGeneration: `${
            daemonMergedProjectionInputs?.pluginProjectionV2?.generation ?? 'unavailable'
        }:${selectedMachine?.daemonStateVersion ?? 0}`,
        agent: null,
        knownAgents: projectedExternalSessionAgents,
        enabled: props.integrationInventoryEnabled === true && props.integrations === undefined,
    });
    const machineItems = React.useMemo((): DropdownMenuItem[] => selectableMachines.map((machine) => ({
        id: machine.id,
        title: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id,
        subtitle: isMachineOnline(machine)
            ? t('externalSessions.settingsMachineOnline')
            : t('externalSessions.settingsMachineOffline'),
        icon: <SafeIonicons name="laptop-outline" size={22} color={theme.colors.text.secondary} />,
    })), [selectableMachines, theme.colors.text.secondary]);
    const hasActiveFollowPolicy = rows.some((row) => row.enabled);
    const pendingSessionIdsRef = React.useRef(new Set<string>());
    const [pendingSessionIds, setPendingSessionIds] = React.useState<ReadonlySet<string>>(
        () => new Set(),
    );
    const [mutationStatusBySessionId, setMutationStatusBySessionId] = React.useState<
        ReadonlyMap<string, 'error' | 'unsupported'>
    >(() => new Map());
    const restartFollowMutationPendingRef = React.useRef(false);
    const [restartFollowMutationPending, setRestartFollowMutationPending] = React.useState(false);

    const setRestartFollowEnabled = React.useCallback(async (enabled: boolean) => {
        if (restartFollowMutationPendingRef.current) return;

        restartFollowMutationPendingRef.current = true;
        setRestartFollowMutationPending(true);
        try {
            await sync.mutateAccountSettings((raw) => ({
                ...raw,
                externalSessionsSettingsV1: patchExternalSessionsSettingsV1(
                    raw.externalSessionsSettingsV1,
                    { keepPassivelyFollowingAfterRestart: enabled },
                ),
            }));
        } catch {
            await Modal.alertAsync(
                t('common.error'),
                t('externalSessions.settingsRestoreUpdateFailed'),
            );
        } finally {
            restartFollowMutationPendingRef.current = false;
            setRestartFollowMutationPending(false);
        }
    }, []);

    const setSessionFollowEnabled = React.useCallback(async (row: FollowRow, enabled: boolean) => {
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
            const result = await machineExternalSessionFollowPolicySet({
                machineId: link.machineId,
                sessionId: row.session.id,
                agentId: link.agentId,
                remoteSessionId: link.remoteSessionId,
                source: link.source,
                enabled,
            }, row.session.serverId ? { serverId: row.session.serverId } : undefined);
            if (!result.ok) {
                const mutationStatus = result.error === 'background_follow_not_supported'
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
            sync.applySessionMetadataLocally(row.session.id, (metadata) =>
                updateMetadataWithExternalSessionFollowPolicy(metadata, {
                    policy: enabled ? 'background_follow' : 'attached_only',
                    updatedAtMs: result.updatedAtMs,
                }),
            );
            setMutationStatusBySessionId((current) => {
                if (!current.has(row.session.id)) return current;
                const next = new Map(current);
                next.delete(row.session.id);
                return next;
            });
        } catch {
            setMutationStatusBySessionId((current) => {
                const next = new Map(current);
                next.set(row.session.id, 'error');
                return next;
            });
            await Modal.alert(
                t('common.error'),
                t('externalSessions.followUpdateFailed'),
            );
        } finally {
            pendingSessionIdsRef.current.delete(row.session.id);
            setPendingSessionIds((current) => {
                if (!current.has(row.session.id)) return current;
                const next = new Set(current);
                next.delete(row.session.id);
                return next;
            });
        }
    }, [mutationStatusBySessionId]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ContextBar
                mode="machine_only"
                machine={{
                    title: t('externalSessions.settingsMachineTitle'),
                    selectedId: selectedMachine?.id ?? null,
                    subtitle: selectedMachine?.metadata?.displayName
                        ?? selectedMachine?.metadata?.host
                        ?? t('externalSessions.settingsMachineUnavailable'),
                    items: machineItems,
                    onSelect: setSelectedMachineId,
                }}
            />
            <ExternalSessionsIntegrationSection
                integrations={props.integrations === undefined
                    ? integrationController.integrations
                    : props.integrations}
                autoLinkSources={props.autoLinkSources === undefined
                    ? persistedAutoLinkSources
                    : props.autoLinkSources}
                machineId={selectedMachine?.id ?? null}
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
            />
            <ItemGroup
                title={t('externalSessions.settingsFollowGroupTitle')}
                footer={t('externalSessions.settingsRestoreFooter')}
            >
                <Item
                    testID="settings-external-sessions-restore-item"
                    title={t('externalSessions.settingsRestoreTitle')}
                    subtitle={settings.keepPassivelyFollowingAfterRestart
                        ? t('externalSessions.settingsRestoreEnabledSubtitle')
                        : t('externalSessions.settingsRestoreDisabledSubtitle')}
                    icon={<SafeIonicons name="refresh-outline" size={29} color={theme.colors.accent.blue} />}
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
                    icon={<SafeIonicons name="notifications-outline" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup
                title={t('externalSessions.settingsActiveFollowsGroupTitle')}
                footer={t('externalSessions.settingsActiveFollowsFooter')}
            >
                {rows.length === 0 ? (
                    <Item
                        testID="settings-external-sessions-follow-empty"
                        mode="info"
                        title={t('externalSessions.settingsActiveFollowsEmptyTitle')}
                        subtitle={t('externalSessions.settingsActiveFollowsEmptySubtitle')}
                        icon={<SafeIonicons name="link-outline" size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                ) : rows.map((row) => {
                    const pending = pendingSessionIds.has(row.session.id);
                    const mutationStatus = mutationStatusBySessionId.get(row.session.id);
                    const status = mutationStatus ?? row.status;
                    const disabled = pending
                        || !row.canChange
                        || (!row.enabled && mutationStatus === 'unsupported');
                    return (
                        <Item
                            key={row.session.id}
                            testID={`settings-external-sessions-follow-item-${row.session.id}`}
                            title={row.title}
                            subtitle={resolveFollowStatusSubtitle(status)}
                            icon={<SafeIonicons name="link-outline" size={29} color={theme.colors.text.secondary} />}
                            loading={pending}
                            disabled={disabled}
                            rightElement={(
                                <Switch
                                    testID={`settings-external-sessions-follow-toggle-${row.session.id}`}
                                    accessibilityLabel={row.title}
                                    accessibilityHint={t('externalSessions.settingsFollowToggleHint')}
                                    value={row.enabled}
                                    disabled={disabled}
                                    onValueChange={(enabled) => {
                                        void setSessionFollowEnabled(row, enabled);
                                    }}
                                />
                            )}
                            rightElementOutsidePressable
                            showChevron={false}
                            onPress={() => setSessionFollowEnabled(row, !row.enabled)}
                        />
                    );
                })}
            </ItemGroup>

            <ItemGroup title={t('externalSessions.settingsSafetyGroupTitle')}>
                <Item
                    testID="settings-external-sessions-passive-info"
                    mode="info"
                    title={t('externalSessions.settingsPassiveTitle')}
                    subtitle={t('externalSessions.settingsPassiveSubtitle')}
                    icon={<SafeIonicons name="eye-outline" size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});

export default ExternalSessionsSettingsView;
