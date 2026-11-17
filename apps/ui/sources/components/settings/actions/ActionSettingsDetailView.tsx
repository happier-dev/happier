import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { PluginActionPlacementV2Schema, type PluginActionPlacementV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { findActionSpec, getActionSpec, isActionEffectHookableV1, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { AutomationTriggerActionIdV1Schema } from '@happier-dev/protocol/automations/automationActionIdentityV1';
import { SubjectTriggersSectionContent } from '@/components/workflows/triggers/SubjectTriggersSection';
import { useActionAutomationsSection } from '@/components/workflows/triggers/useResourceAutomationsSection';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { parseQualifiedPluginResourcePolicyId, formatQualifiedPluginResourcePolicyId, type ActionSettingsActionId } from '@happier-dev/protocol/actions/actionSettings';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows, type ItemLoadState } from '@/components/ui/lists/ItemLoadStateRows';
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
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { ActionApprovalLooseningNotice } from './ActionApprovalLooseningNotice';
import { ActionMachineApprovalSection } from './ActionMachineApprovalSection';
import { ActionSettingsTargetModeControl } from './ActionSettingsTargetModeControl';
import { ActionSettingsToolExposureControl } from './ActionSettingsToolExposureControl';
import {
    resolveActionSettingsTargetPolicyInput,
    resolveActionSettingsTargetControlState,
    resolveActionSettingsToolExposureState,
    type ActionSettingsApprovalControlValue,
    type ActionSettingsBooleanControlValue,
    type ActionSettingsTargetControlState,
    type ActionSettingsToolExposureControlValue,
    type ActionSettingsTargetCategory,
} from './actionSettingsTargets';
import {
    buildActionSettingsEntries,
    ACTION_SETTINGS_PROJECTION_SECTIONS,
    buildActionSettingsContributedActions,
    type ActionSettingsEntry,
    type ActionSettingsTargetEntry,
} from './buildActionSettingsEntries';
import { listActionSettingsFacts, listActionSettingsTargetDefinitions } from './actionSettingsTargetDefinitions';
import { useActionSettingsNarrowLayout } from './useActionSettingsNarrowLayout';
import { SessionAgentSpawnPolicyControls } from './SessionAgentSpawnPolicyControls';
import { useActionPolicyWriter } from './useActionPolicyWriter';
import { ACCOUNT_ACTION_SETTINGS_TARGET, approvalProfileSetsAction, buildApprovalProfileActionResetChange,
    useActionSettingsForTarget, type ActionSettingsTarget } from './actionSettingsTarget';
import { RoundButton } from '@/components/ui/buttons/RoundButton';

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
    const resource = parseQualifiedPluginResourcePolicyId(decoded);
    return contributedAction
        ? formatQualifiedPluginActionId(contributedAction)
        : resource ? formatQualifiedPluginResourcePolicyId(resource) : null;
}

/** One name per contribution placement binding, keyed by the Protocol vocabulary so a new binding must be named. */
const PLACEMENT_BINDING_TITLE_KEYS = {
    primary: 'settingsActions.targets.contextual_ui.bindings.primary',
    secondary: 'settingsActions.targets.contextual_ui.bindings.secondary',
    rowAction: 'settingsActions.targets.contextual_ui.bindings.rowAction',
    contextMenu: 'settingsActions.targets.contextual_ui.bindings.contextMenu',
    commandPalette: 'settingsActions.targets.contextual_ui.bindings.commandPalette',
    toolbar: 'settingsActions.targets.contextual_ui.bindings.toolbar',
    detailsPanel: 'settingsActions.targets.contextual_ui.bindings.detailsPanel',
    'composer.primary': 'settingsActions.targets.contextual_ui.bindings.composerPrimary',
    'composer.more': 'settingsActions.targets.contextual_ui.bindings.composerMore',
    'composer.slash': 'settingsActions.targets.contextual_ui.bindings.composerSlash',
    'message.menu': 'settingsActions.targets.contextual_ui.bindings.messageMenu',
} as const satisfies Record<PluginActionPlacementV2, string>;

function getTargetSubtitle(
    target: ActionSettingsTargetEntry,
    controlState: ActionSettingsTargetControlState,
    actionId: ActionSettingsActionId,
    placementTitles: readonly string[],
): string {
    // "Where it appears" names the surfaces the contribution declares, by their own titles, never their ids.
    const subtitle = target.id === 'contextual_ui' && placementTitles.length > 0
        ? placementTitles.join(' · ') : t(target.subtitleKey);
    const withReason = target.reasonKey ? `${subtitle} ${t(target.reasonKey)}` : subtitle;
    // Default reads as "inherit", so name the Source Control preference that makes the inherited default ask.
    if (controlState.kind === 'approval' && controlState.value === 'default' && controlState.approvalAskedBySourceControl) {
        return `${withReason} ${t('settingsActions.sourceControlAsks', {
            setting: t(actionId === 'scm.remote.pull'
                ? 'settingsSourceControl.remoteConfirmation.pull.title'
                : 'settingsSourceControl.remoteConfirmation.push.title'),
        })}`;
    }
    return withReason;
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

/** Every surface in one "Who may use it" section: in-app first, then voice, then integrations. */
function orderTargetsByCategory(targets: readonly ActionSettingsTargetEntry[]) {
    return categoryOrder.flatMap((category) => targets.filter((target) => target.category === category));
}

type ActionSettingsDetailContentProps = Readonly<{
    actionId: ActionSettingsActionId;
    target?: ActionSettingsTarget;
}>;

/** In a profile the page edits only what a profile carries: per-surface use and approval, not placements or HTML callers. */
function isProfileTargetRow(target: ActionSettingsTargetEntry): boolean {
    return target.definition.kind === 'surface' && target.definition.surface !== 'foreign_session_html';
}

const ActionSettingsMachineChip = React.memo(function ActionSettingsMachineChip() {
    const selection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.actions,
    );
    return (
        <MachineAdministrationTargetSelector
            selection={selection}
            testIDPrefix="settings.actions.administration.target"
            presentation="chip"
        />
    );
});

export const ActionSettingsDetailContent = React.memo(function ActionSettingsDetailContent(props: ActionSettingsDetailContentProps) {
    const styles = stylesheet;
    const target = props.target ?? ACCOUNT_ACTION_SETTINGS_TARGET;
    const inProfile = target.kind === 'profile';
    const compactLayout = useActionSettingsNarrowLayout();
    const [searchQuery, setSearchQuery] = React.useState('');
    const targetSettings = useActionSettingsForTarget(target);
    const profile = targetSettings.profile;
    const profileRow = targetSettings.profileRow;
    const profileSetsAction = approvalProfileSetsAction(profile, props.actionId);
    // A profile shared with this person to use shows its values; only its editors get controls (05 S7 recipient).
    const readOnly = inProfile && targetSettings.profileCapabilities?.canEdit === false;
    // Workflows run before and after an Action only when its effect can be held (the catalog's hookable rule).
    const automationsActionId = React.useMemo(() => {
        const spec = inProfile ? undefined : findActionSpec(props.actionId);
        const parsed = spec && isActionEffectHookableV1(spec.sideEffectClass) ? AutomationTriggerActionIdV1Schema.safeParse(props.actionId) : null;
        return parsed?.success ? parsed.data : null;
    }, [inProfile, props.actionId]);
    // Until the profile's own row is read, its values are unknown: the rows wait rather than show the Account's as the
    // profile's and offer edits on them (QA-B E9).
    const profileLoad: ItemLoadState | null = !inProfile || targetSettings.profileStatus === 'ready' ? null
        : targetSettings.profileStatus === 'loading' ? { kind: 'loading' }
            : targetSettings.profileStatus === 'missing'
                ? { kind: 'failed', reason: t('workflows.triggers.guided.profile.notFoundDescription') }
                : { kind: 'failed', reason: t('common.requestFailed'), onRetry: targetSettings.retryProfile };
    const writePolicy = useActionPolicyWriter(target);
    const scmRemoteConfirmPolicy = useSetting('scmRemoteConfirmPolicy');
    const rawSpawnPolicy = useSetting('sessionAgentSpawnPolicyV1');
    const rawAllowLists = useSetting('sessionAgentStartAllowListsV1');
    const settings = targetSettings.settings;
    const voiceSettings = useSetting('voice') as Readonly<{ privacy?: { shareDeviceInventory?: boolean } }> | null;
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    const needsMachineProjection = props.actionId === 'capture.view'
        || parseQualifiedPluginActionId(props.actionId) !== null || parseQualifiedPluginResourcePolicyId(props.actionId) !== null;
    const administrationTargetSelection = useMachineAdministrationTargetSelection(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.actions,
        { enabled: needsMachineProjection },
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
        sections: ACTION_SETTINGS_PROJECTION_SECTIONS,
    });
    const contributedActions = React.useMemo(() => (
        executionTarget && daemonMergedProjection.inputs
            ? buildActionSettingsContributedActions(daemonMergedProjection.inputs.pluginProjectionById)
            : []
    ), [daemonMergedProjection.inputs, executionTarget]);
    const captureViewingPlugins = React.useMemo(() => (
        !inProfile && props.actionId === 'capture.view' && executionTarget && daemonMergedProjection.inputs
            ? Object.values(daemonMergedProjection.inputs.pluginProjectionById)
                .filter((plugin) => plugin.title.toLowerCase().includes(searchQuery.trim().toLowerCase()))
                .sort((left, right) => left.title.localeCompare(right.title))
            : []
    ), [daemonMergedProjection.inputs, executionTarget, inProfile, props.actionId, searchQuery]);
    const voiceShareDeviceInventory = voiceSettings?.privacy?.shareDeviceInventory !== false;
    const availability = React.useMemo(() => ({
        executionRunsEnabled,
        memorySearchEnabled,
        voiceEnabled,
        sessionHandoffEnabled,
        voiceShareDeviceInventory,
    }), [
        executionRunsEnabled,
        memorySearchEnabled,
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
        entry?.targets.filter((row) => targetMatchesSearch(row, searchQuery) && (!inProfile || isProfileTargetRow(row))) ?? []
    ), [entry?.targets, inProfile, searchQuery]);
    const orderedTargets = React.useMemo(() => orderTargetsByCategory(filteredTargets), [filteredTargets]);
    // The contribution's own placement bindings say where "Where it appears" points; host placements have rows of their own.
    const placementTitles = React.useMemo(() => {
        const contributed = contributedActions.find((action) => entry?.actionId === formatQualifiedPluginActionId({
            pluginId: action.pluginId, localId: action.localId,
        }));
        return (contributed?.placementBindings ?? []).flatMap((binding) => {
            const placement = PluginActionPlacementV2Schema.safeParse(binding);
            return placement.success ? [t(PLACEMENT_BINDING_TITLE_KEYS[placement.data])] : [];
        });
    }, [contributedActions, entry?.actionId]);
    // Only Actions whose spec declares Machine approval scope offer per-Machine preferences.
    const machineScoped = React.useMemo(() => {
        if (inProfile) return null;
        const hostId = ActionIdSchema.safeParse(props.actionId);
        return hostId.success && getActionSpec(hostId.data).approvalScope === 'machine' ? hostId.data : null;
    }, [inProfile, props.actionId]);
    const toolExposureTargets = React.useMemo(() => (inProfile ? [] : filteredTargets
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
            .filter((row): row is NonNullable<typeof row> => row !== null)
    ), [entry, filteredTargets, inProfile, settings]);
    const facts = React.useMemo(() => listActionSettingsFacts(props.actionId), [props.actionId]);

    const handleActionEnabledChange = React.useCallback((enabled: boolean) => {
        void writePolicy({ actionId: props.actionId, change: { kind: 'enabled', enabled } });
    }, [writePolicy, props.actionId]);

    const handleTargetControlChange = React.useCallback((
        target: ActionSettingsTargetEntry,
        value: ActionSettingsApprovalControlValue | ActionSettingsBooleanControlValue,
    ) => {
        void writePolicy(resolveActionSettingsTargetPolicyInput({
            settings,
            actionId: props.actionId,
            targetId: target.id,
            target: target.definition,
            value,
            scmRemoteConfirmPolicy,
        }));
    }, [writePolicy, settings, props.actionId, scmRemoteConfirmPolicy]);

    const handleToolExposureChange = React.useCallback((
        target: ActionSettingsTargetEntry,
        value: ActionSettingsToolExposureControlValue,
    ) => {
        if (entry?.kind !== 'host' || target.definition.kind !== 'surface') return;
        const surface = target.definition.surface;
        if (surface !== 'agent' && surface !== 'mcp' && surface !== 'cli') return;
        void writePolicy({ actionId: entry.actionId, change: { kind: 'tool_exposure', surface, mode: value } });
    }, [writePolicy, entry]);

    // The machine chip stays live in the header, while ordinary built-in action content does not
    // subscribe to the high-frequency inventory projection it does not consume.
    const machineChip = <ActionSettingsMachineChip />;

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
                description={entry.description ?? undefined}
                actions={(
                    <View style={styles.headerActions}>
                        {machineChip}
                        {inProfile ? null : <View testID={`settings-actions:action:${entry.actionId}:summary`}>
                            <PageHeaderStateSwitch
                                testID={`settings-actions:action:${entry.actionId}:enabled`}
                                label={t('common.enabled')}
                                accessibilityLabel={entry.title}
                                value={entry.enabled}
                                onValueChange={handleActionEnabledChange}
                            />
                        </View>}
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

            <CompactSearchField
                placement="page"
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('settingsActions.detailSearchPlaceholder')}
            />

            {orderedTargets.length === 0 ? (
                <ItemGroup>
                    <Item
                        testID={`settings-actions:action:${entry.actionId}:no-targets`}
                        title={t('settingsActions.noTargetsMatch')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}

            {orderedTargets.length > 0 ? (() => {
                const rows = orderedTargets.map((target) => {
                    const available = target.state !== 'unavailable';
                    return {
                        target,
                        available,
                        testIDPrefix: `settings-actions:action:${entry.actionId}:target:${target.id}`,
                        controlState: resolveActionSettingsTargetControlState({
                            settings,
                            actionId: entry.actionId,
                            targetId: target.id,
                            target: target.definition,
                            available,
                            scmRemoteConfirmPolicy,
                        }),
                    };
                });
                return (
                    <ItemGroup
                        title={t('settingsActions.sections.whoMayUseIt')}
                        // How "Ask first" and "Allowed" differ, said once above the surfaces. In a profile the
                        // section first says whose answer the rows show, and offers the way back to the Account's.
                        description={profileLoad !== null ? undefined : inProfile
                            ? t(profileSetsAction ? 'workflows.triggers.guided.profile.actionSetByProfile'
                                : 'workflows.triggers.guided.profile.actionFollowsAccount')
                            : parseQualifiedPluginResourcePolicyId(entry.actionId) ? undefined : t('settingsActions.approvalHelpBody')}
                        action={inProfile && profileRow && profileSetsAction && !readOnly ? (
                            <RoundButton
                                testID={`settings-actions:action:${entry.actionId}:use-account-setting`}
                                size="small"
                                display="inverted"
                                title={t('workflows.triggers.guided.profile.useAccountSetting')}
                                onPress={() => { void writePolicy(buildApprovalProfileActionResetChange(profileRow, entry.actionId as ActionSettingsActionId)); }}
                            />
                        ) : undefined}
                    >
                        {profileLoad !== null ? (
                            <ItemLoadStateRows testID={`settings-actions:action:${entry.actionId}:profile-read`}
                                state={profileLoad} rows={rows.length} lines={2}
                                accessibilityLabel={t('settingsActions.sections.whoMayUseIt')} />
                        ) : null}
                        {/* The loosening warning leads the section holding the Allowed choice, one per exact
                            key, so Keep Ask first restores only that surface. */}
                        {profileLoad !== null ? null : rows.map(({ target, testIDPrefix, controlState }) => (
                            controlState.kind === 'approval' && controlState.approvalLooseningNotice && !readOnly ? (
                                <ActionApprovalLooseningNotice
                                    key={`${target.id}:loosening`}
                                    target={props.target}
                                    testID={`${testIDPrefix}:loosening`}
                                    notice={controlState.approvalLooseningNotice}
                                    disabled={!entry.enabled}
                                />
                            ) : null
                        ))}
                        {profileLoad !== null ? null : rows.map(({ target, available, testIDPrefix, controlState }) => {
                            const shouldStackModeControl = compactLayout && controlState.kind === 'approval';
                            const targetModeControl = (
                                <ActionSettingsTargetModeControl
                                    testIDPrefix={testIDPrefix}
                                    accessibilityLabel={t(target.titleKey)}
                                    controlState={controlState}
                                    disabled={!entry.enabled || !available}
                                    readOnly={readOnly}
                                    layout={shouldStackModeControl ? 'stacked' : 'inline'}
                                    onChange={(value) => handleTargetControlChange(target, value)}
                                />
                            );

                            return (
                                <Item
                                    key={target.id}
                                    testID={testIDPrefix}
                                    title={t(target.titleKey)}
                                    subtitle={getTargetSubtitle(target, controlState, entry.actionId, placementTitles)}
                                    mode={available && !readOnly ? 'interactive' : 'info'}
                                    disabled={!entry.enabled || !available}
                                    showChevron={false}
                                    subtitleAccessory={shouldStackModeControl ? targetModeControl : null}
                                    rightElement={shouldStackModeControl ? null : targetModeControl}
                                />
                            );
                        })}
                    </ItemGroup>
                );
            })() : null}

            {machineScoped && entry.kind === 'host' ? (
                <ActionMachineApprovalSection actionId={machineScoped} settings={settings} disabled={!entry.enabled} />
            ) : null}

            {/* A hookable Action's Automations are the shared section (05 S5 Action detail), in place of its Workflows facts. */}
            {automationsActionId !== null ? (
                <ActionAutomationsSection actionId={automationsActionId} title={entry.title}
                    hasFacts={facts.some((fact) => fact.section === 'automations')}>
                    {facts.filter((fact) => fact.section === 'automations').map((fact) => (
                        <Item
                            key={fact.id}
                            testID={`settings-actions:action:${entry.actionId}:fact:${fact.id}`}
                            title={t(fact.titleKey)}
                            subtitle={t(fact.subtitleKey)}
                            mode="info"
                            showChevron={false}
                        />
                    ))}
                </ActionAutomationsSection>
            ) : null}

            {(['automations', 'alwaysTrue'] as const).map((section) => {
                if (section === 'automations' && automationsActionId !== null) return null;
                const sectionFacts = facts.filter((fact) => fact.section === section);
                return sectionFacts.length > 0 ? (
                    <ItemGroup
                        key={section}
                        title={t(section === 'automations'
                            ? 'settingsActions.facts.automationsSection'
                            : 'settingsActions.facts.alwaysTrueSection')}
                    >
                        {sectionFacts.map((fact) => (
                            <Item
                                key={fact.id}
                                testID={`settings-actions:action:${entry.actionId}:fact:${fact.id}`}
                                title={t(fact.titleKey)}
                                subtitle={t(fact.subtitleKey)}
                                mode="info"
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                ) : null;
            })}

            {captureViewingPlugins.length > 0 ? (
                <ItemGroup title={t('settingsActions.targets.plugin.title')} description={t('settingsActions.approvalHelpBody')}>
                    {captureViewingPlugins.map((plugin) => {
                        const waived = settings.pluginHostCaptureApprovalWaived?.includes(plugin.pluginId) === true;
                        const control = (
                            <SegmentedTabBar
                                role="radiogroup"
                                accessibilityLabel={plugin.title}
                                testIDPrefix={`settings-actions:host-capture:${plugin.pluginId}:mode`}
                                tabs={[
                                    { id: 'ask_first', label: t('settingsActions.modes.askFirst') },
                                    { id: 'allowed', label: t('settingsActions.modes.allowed') },
                                ]}
                                activeTabId={waived ? 'allowed' : 'ask_first'}
                                disabled={!entry.enabled}
                                onSelectTab={(value) => {
                                    void writePolicy({ actionId: 'capture.view', change: {
                                        kind: 'plugin_host_capture', pluginId: plugin.pluginId,
                                        approvalRequired: value !== 'allowed',
                                    } });
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
                                disabled={!entry.enabled || !available || readOnly}
                                onChange={(value) => handleToolExposureChange(target, value)}
                            />
                        );
                    })}
                </ItemGroup>
            ) : null}

            {!inProfile && entry.kind === 'host' && entry.actionId === 'session.spawn_new' ? (
                <SessionAgentSpawnPolicyControls
                    rawPolicy={rawSpawnPolicy}
                    rawAllowLists={rawAllowLists}
                    disabled={!entry.enabled}
                />
            ) : null}
        </ItemList>
    );
});

export const ActionSettingsDetailView = React.memo(function ActionSettingsDetailView(props: Readonly<{ target?: ActionSettingsTarget }>) {
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
            <ActionSettingsDetailContent actionId={actionId} target={props.target} />
        </>
    );
});

/** The Action's before/after attachments, through the shared selected read and section on the active Account. */
const ActionAutomationsSection = React.memo(function ActionAutomationsSection(props: Readonly<{
    actionId: Parameters<typeof useActionAutomationsSection>[0]['actionId'];
    title: string;
    /** The Action's own facts about what runs around it ("Scheduled reviews use the Agents setting above"). */
    hasFacts: boolean;
    children?: React.ReactNode;
}>) {
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const automations = useActionAutomationsSection({ actionId: props.actionId, accountLifetime });
    const subject = React.useMemo(() => ({ kind: 'action' as const, actionId: props.actionId }), [props.actionId]);
    return <SubjectTriggersSectionContent subject={subject} subjectName={props.title} automations={automations}
        hasRetainedContent={props.hasFacts}>{props.children}</SubjectTriggersSectionContent>;
});
