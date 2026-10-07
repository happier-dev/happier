import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionSettingsActionId } from '@happier-dev/protocol/actions/actionSettings';

import { SearchHeader } from '@/components/ui/forms/SearchHeader';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderStateSwitch } from '@/components/ui/layout/PageHeaderEntityParts';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { ActionSettingsTargetModeControl } from './ActionSettingsTargetModeControl';
import { ActionSettingsToolExposureControl } from './ActionSettingsToolExposureControl';
import {
    applyActionSettingsTargetControlState,
    resolveActionSettingsTargetControlState,
    resolveActionSettingsToolExposureState,
    setActionEnabled,
    setActionSettingsToolExposureMode,
    type ActionSettingsApprovalControlValue,
    type ActionSettingsBooleanControlValue,
    type ActionSettingsToolExposureControlValue,
    type ActionSettingsTargetCategory,
} from './actionSettingsTargets';
import {
    buildActionSettingsEntries,
    buildActionSettingsContributedActions,
    type ActionSettingsEntry,
    type ActionSettingsTargetEntry,
} from './buildActionSettingsEntries';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import { listActionSettingsTargetDefinitions } from './actionSettingsTargetDefinitions';
import { useActionSettingsNarrowLayout } from './useActionSettingsNarrowLayout';
import { SessionAgentSpawnPolicyControls } from './SessionAgentSpawnPolicyControls';

const categoryOrder: readonly ActionSettingsTargetCategory[] = ['app', 'voice', 'integrations'];

const stylesheet = StyleSheet.create(() => ({
    headerActions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 12,
    },
}));

function getSearchParamValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

function decodeActionIdParam(value: string | string[] | undefined): ActionSettingsActionId | null {
    const raw = getSearchParamValue(value);
    if (!raw) {
        return null;
    }

    const decoded = decodeURIComponent(raw);
    const spec = listActionSpecs().find((candidate) => candidate.id === decoded);
    if (spec && listActionSettingsTargetDefinitions(spec).length > 0) {
        return spec.id;
    }
    const contributedAction = parseQualifiedPluginActionId(decoded);
    return contributedAction
        ? formatQualifiedPluginActionId(contributedAction)
        : null;
}

function getTargetSubtitle(target: ActionSettingsTargetEntry): string {
    const subtitle = t(target.subtitleKey);
    if (!target.reasonKey) {
        return subtitle;
    }
    return `${subtitle} ${t(target.reasonKey)}`;
}

function targetMatchesSearch(target: ActionSettingsTargetEntry, query: string): boolean {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return true;
    }

    const searchable = [
        target.id,
        t(target.titleKey),
        t(target.subtitleKey),
        target.reasonKey ? t(target.reasonKey) : '',
    ].join(' ').toLowerCase();

    return normalizedQuery
        .split(/\s+/)
        .filter(Boolean)
        .every((token) => searchable.includes(token));
}

function groupTargetsByCategory(targets: readonly ActionSettingsTargetEntry[]) {
    return categoryOrder
        .map((category) => ({
            category,
            targets: targets.filter((target) => target.category === category),
        }))
        .filter((section) => section.targets.length > 0);
}

function getCategoryTitleKey(category: ActionSettingsTargetCategory) {
    switch (category) {
        case 'app':
            return 'settingsActions.sections.app';
        case 'voice':
            return 'settingsActions.sections.voice';
        case 'integrations':
            return 'settingsActions.sections.integrations';
    }
}

type ActionSettingsDetailContentProps = Readonly<{
    actionId: ActionSettingsActionId;
}>;

export const ActionSettingsDetailContent = React.memo(function ActionSettingsDetailContent(props: ActionSettingsDetailContentProps) {
    const styles = stylesheet;
    const compactLayout = useActionSettingsNarrowLayout();
    const [searchQuery, setSearchQuery] = React.useState('');
    const [rawSettings, setRawSettings] = useSettingMutable('actionsSettingsV1');
    const [rawSpawnPolicy, setRawSpawnPolicy] = useSettingMutable('sessionAgentSpawnPolicyV1');
    const [rawAllowLists, setRawAllowLists] = useSettingMutable('sessionAgentStartAllowListsV1');
    const settings = React.useMemo(() => normalizeActionsSettings(rawSettings), [rawSettings]);
    const voiceSettings = useSetting('voice') as Readonly<{ privacy?: { shareDeviceInventory?: boolean } }> | null;
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    const mcpServersEnabled = useFeatureEnabled('mcp.servers');
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.actions,
    );
    const executionTarget = React.useMemo(() => {
        const selectedTarget = administrationTargetSelection.selectedTarget;
        const resolvedTarget = administrationTargetSelection.resolveExecutionTarget();
        return selectedTarget !== null
            && resolvedTarget !== null
            && machineAdministrationTargetsEqual(selectedTarget, resolvedTarget.target)
            ? resolvedTarget
            : null;
    }, [administrationTargetSelection]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: executionTarget?.machine.id ?? null,
        serverId: executionTarget?.serverId ?? null,
        enabled: executionTarget !== null,
    });
    const contributedActions = React.useMemo(() => (
        executionTarget && daemonMergedProjection.inputs
            ? buildActionSettingsContributedActions(daemonMergedProjection.inputs.pluginProjectionById)
            : []
    ), [daemonMergedProjection.inputs, executionTarget]);
    const captureViewingPlugins = React.useMemo(() => (
        props.actionId === 'capture.view' && executionTarget && daemonMergedProjection.inputs
            ? Object.values(daemonMergedProjection.inputs.pluginProjectionById)
                .filter((plugin) => plugin.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))
                .sort((left, right) => left.title.localeCompare(right.title))
            : []
    ), [daemonMergedProjection.inputs, executionTarget, props.actionId, searchQuery]);
    const voiceShareDeviceInventory = voiceSettings?.privacy?.shareDeviceInventory !== false;
    const availability = React.useMemo(() => ({
        executionRunsEnabled,
        memorySearchEnabled,
        voiceEnabled,
        sessionHandoffEnabled,
        mcpServersEnabled,
        voiceShareDeviceInventory,
    }), [
        executionRunsEnabled,
        memorySearchEnabled,
        mcpServersEnabled,
        sessionHandoffEnabled,
        voiceEnabled,
        voiceShareDeviceInventory,
    ]);
    const entry = React.useMemo<ActionSettingsEntry | null>(() => {
        const entries = buildActionSettingsEntries({
            query: '',
            settings,
            availability,
            contributedActions,
            translate: t,
        });
        return entries.find((candidate) => candidate.actionId === props.actionId) ?? null;
    }, [availability, contributedActions, props.actionId, settings]);
    const filteredTargets = React.useMemo(() => (
        entry?.targets.filter((target) => targetMatchesSearch(target, searchQuery)) ?? []
    ), [entry?.targets, searchQuery]);
    const targetSections = React.useMemo(() => groupTargetsByCategory(filteredTargets), [filteredTargets]);
    const toolExposureTargets = React.useMemo(() => (
        filteredTargets
            .map((target) => {
                const available = target.state !== 'unavailable';
                const exposureState = entry?.kind === 'host'
                    ? resolveActionSettingsToolExposureState({
                        settings,
                        actionId: entry.actionId,
                        targetId: target.id,
                        available,
                    })
                    : { kind: 'hidden' as const };
                return exposureState.kind === 'visible'
                    ? { target, available, exposureState }
                    : null;
            })
            .filter((target): target is NonNullable<typeof target> => target !== null)
    ), [entry, filteredTargets, settings]);

    const commitSettings = React.useCallback((next: unknown) => {
        setRawSettings(normalizeActionsSettings(next));
    }, [setRawSettings]);

    const handleActionEnabledChange = React.useCallback((enabled: boolean) => {
        commitSettings(setActionEnabled({
            settings,
            actionId: props.actionId,
            enabled,
        }));
    }, [commitSettings, props.actionId, settings]);

    const handleTargetControlChange = React.useCallback((
        target: ActionSettingsTargetEntry,
        value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue,
    ) => {
        commitSettings(applyActionSettingsTargetControlState({
            settings,
            actionId: props.actionId,
            targetId: target.id,
            target: target.definition,
            value,
        }));
    }, [commitSettings, props.actionId, settings]);

    const handleToolExposureChange = React.useCallback((
        target: ActionSettingsTargetEntry,
        value: ActionSettingsToolExposureControlValue,
    ) => {
        if (entry?.kind !== 'host') return;
        commitSettings(setActionSettingsToolExposureMode({
            settings,
            actionId: entry.actionId,
            targetId: target.id,
            value,
        }));
    }, [commitSettings, entry, settings]);

    // The machine chip scopes contributed actions only; it stays in the header in every state
    // because it is how a contributed action that is not declared here becomes reachable.
    const machineChip = (
        <MachineAdministrationTargetSelector
            selection={administrationTargetSelection}
            testIDPrefix="settings.actions.administration.target"
            presentation="chip"
        />
    );

    if (!entry) {
        return (
            <ItemList>
                <PageHeader
                    title={t('settingsActions.invalidActionTitle')}
                    description={t('settingsActions.invalidActionSubtitle')}
                    actions={machineChip}
                />
            </ItemList>
        );
    }

    return (
        <ItemList>
            <PageHeader
                testID={`settings-actions:action:${entry.actionId}:header`}
                title={entry.title}
                description={entry.description ?? t('settingsActions.noDescription')}
                actions={(
                    <View style={styles.headerActions}>
                        {machineChip}
                        <View testID={`settings-actions:action:${entry.actionId}:summary`}>
                            <PageHeaderStateSwitch
                                testID={`settings-actions:action:${entry.actionId}:enabled`}
                                label={t('common.enabled')}
                                accessibilityLabel={entry.title}
                                value={entry.enabled}
                                onValueChange={handleActionEnabledChange}
                            />
                        </View>
                    </View>
                )}
            />

            {entry.kind === 'retained' ? (
                <AttentionBanner
                    testID="settings-actions:contributed:retained"
                    tone="neutral"
                    title={t('settingsActions.contributed.removedTargetsTitle')}
                    description={t('settingsActions.contributed.removedTargetsBody')}
                />
            ) : null}

            <SearchHeader
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('settingsActions.detailSearchPlaceholder')}
            />

            {targetSections.length === 0 ? (
                <ItemGroup>
                    <Item
                        testID={`settings-actions:action:${entry.actionId}:no-targets`}
                        title={t('settingsActions.noTargetsMatch')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {targetSections.map((section, index) => (
                <ItemGroup
                    key={section.category}
                    title={t(getCategoryTitleKey(section.category))}
                    // How "Ask first" and "Allowed" differ, said once above the first surfaces.
                    description={index === 0 ? t('settingsActions.approvalHelpBody') : undefined}
                >
                    {section.targets.map((target) => {
                        const targetTestIDPrefix = `settings-actions:action:${entry.actionId}:target:${target.id}`;
                        const available = target.state !== 'unavailable';
                        const controlState = resolveActionSettingsTargetControlState({
                            settings,
                            actionId: entry.actionId,
                            targetId: target.id,
                            target: target.definition,
                            available,
                        });
                        const shouldStackModeControl = compactLayout && controlState.kind === 'approval';
                        const targetModeControl = (
                            <ActionSettingsTargetModeControl
                                testIDPrefix={targetTestIDPrefix}
                                accessibilityLabel={t(target.titleKey)}
                                controlState={controlState}
                                disabled={!entry.enabled || !available}
                                layout={shouldStackModeControl ? 'stacked' : 'inline'}
                                onChange={(value) => handleTargetControlChange(target, value)}
                            />
                        );

                        return (
                            <Item
                                key={target.id}
                                testID={targetTestIDPrefix}
                                title={t(target.titleKey)}
                                subtitle={getTargetSubtitle(target)}
                                mode={available ? 'interactive' : 'info'}
                                disabled={!entry.enabled || !available}
                                showChevron={false}
                                subtitleAccessory={shouldStackModeControl ? targetModeControl : null}
                                rightElement={shouldStackModeControl ? null : targetModeControl}
                            />
                        );
                    })}
                </ItemGroup>
            ))}

            {captureViewingPlugins.length > 0 ? (
                <ItemGroup title={t('settingsActions.targets.plugin.title')} description={t('settingsActions.approvalHelpBody')}>
                    {captureViewingPlugins.map((plugin) => {
                        const waived = settings.pluginHostCaptureApprovalWaived?.includes(plugin.pluginId) === true;
                        const control = (
                            <SegmentedTabBar
                                role="radiogroup"
                                accessibilityLabel={plugin.title}
                                testIDPrefix={`settings-actions:host-capture:${plugin.pluginId}:mode`}
                                targetSize="platform"
                                tabs={[
                                    { id: 'ask_first', label: t('settingsActions.modes.askFirst') },
                                    { id: 'allowed', label: t('settingsActions.modes.allowed') },
                                ]}
                                activeTabId={waived ? 'allowed' : 'ask_first'}
                                disabled={!entry.enabled}
                                onSelectTab={(value) => {
                                    const remaining = settings.pluginHostCaptureApprovalWaived?.filter(id => id !== plugin.pluginId) ?? [];
                                    commitSettings({ ...settings, pluginHostCaptureApprovalWaived:
                                        value === 'allowed' ? [...remaining, plugin.pluginId] : remaining });
                                }}
                            />
                        );
                        return <Item
                            key={plugin.pluginId}
                            testID={`settings-actions:host-capture:${plugin.pluginId}`}
                            title={plugin.title}
                            disabled={!entry.enabled}
                            showChevron={false}
                            accessoryLayout="adaptive"
                            rightElement={control}
                        />;
                    })}
                </ItemGroup>
            ) : null}

            {toolExposureTargets.length > 0 ? (
                <ItemGroup
                    title={t('settingsActions.toolExposure.title')}
                    description={t('settingsActions.toolExposure.footer')}
                >
                    {toolExposureTargets.map(({ target, available, exposureState }) => {
                        const exposureTestIDPrefix = `settings-actions:action:${entry.actionId}:target:${target.id}:tool-exposure`;
                        return (
                            <ActionSettingsToolExposureControl
                                key={target.id}
                                testIDPrefix={exposureTestIDPrefix}
                                surfaceTitle={t(target.titleKey)}
                                state={exposureState}
                                disabled={!entry.enabled || !available}
                                onChange={(value) => handleToolExposureChange(target, value)}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}

            {entry.kind === 'host' && entry.actionId === 'session.spawn_new' ? (
                <SessionAgentSpawnPolicyControls
                    rawPolicy={rawSpawnPolicy}
                    rawAllowLists={rawAllowLists}
                    disabled={!entry.enabled}
                    onChange={setRawSpawnPolicy}
                    onAllowListsChange={setRawAllowLists}
                />
            ) : null}
        </ItemList>
    );
});

export const ActionSettingsDetailView = React.memo(function ActionSettingsDetailView() {
    const params = useLocalSearchParams<{ actionId?: string | string[] }>();
    const actionId = decodeActionIdParam(params.actionId);
    const actionTitle = actionId
        ? listActionSpecs().find((spec) => spec.id === actionId)?.title
        : null;
    const invalidActionTitle = t('settingsActions.invalidActionTitle');
    const fallbackActionTitle = t('common.actions');
    const invalidActionScreenOptions = React.useMemo(
        () => ({ headerTitle: invalidActionTitle }),
        [invalidActionTitle],
    );
    const actionScreenOptions = React.useMemo(
        () => ({ headerTitle: actionTitle ?? fallbackActionTitle }),
        [actionTitle, fallbackActionTitle],
    );

    if (!actionId) {
        return (
            <>
                <Stack.Screen options={invalidActionScreenOptions} />
                <ItemList>
                    <PageHeader
                        title={invalidActionTitle}
                        description={t('settingsActions.invalidActionSubtitle')}
                    />
                </ItemList>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={actionScreenOptions} />
            <ActionSettingsDetailContent actionId={actionId} />
        </>
    );
});
