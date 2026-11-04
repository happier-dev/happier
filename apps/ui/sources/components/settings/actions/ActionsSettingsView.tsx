import * as React from 'react';
import { View, Platform } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { type ActionSettingsActionId, type ActionsSettingsV1 } from '@happier-dev/protocol';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { Text } from '@/components/ui/text/Text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { machineAdministrationTargetsEqual } from '@/sync/domains/machines/administration/targetSelection';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import {
    buildActionSettingsEntries,
    buildActionSettingsContributedActions,
    type ActionSettingsEntry,
} from './buildActionSettingsEntries';
import { groupActionSettingsEntriesByFamily } from './groupActionSettingsEntriesByFamily';
import { useActionPolicyWriter } from './useActionPolicyWriter';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import {
    listActionSettingsEntryStatusParts,
    resolveActionSettingsEntryStatusSummary,
} from './resolveActionSettingsEntryStatusSummary';
import { Icon } from '@/components/ui/icons/Icon';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

const ACTION_SETTINGS_SEGMENT_SIZE = 8;

type ActionSettingsVirtualizedItem =
    | Readonly<{ kind: 'action'; entry: ActionSettingsEntry }>
    | Readonly<{ kind: 'related'; entry: ActionSettingsEntry }>;

type ActionSettingsVirtualizedSegment = Readonly<{
    key: string;
    title?: string;
    titleKey: ReturnType<typeof groupActionSettingsEntriesByFamily>[number]['titleKey'];
    descriptionKey?: ReturnType<typeof groupActionSettingsEntriesByFamily>[number]['descriptionKey'];
    items: readonly ActionSettingsVirtualizedItem[];
    first: boolean;
    last: boolean;
}>;

function buildActionSettingsVirtualizedSegments(
    sections: ReturnType<typeof groupActionSettingsEntriesByFamily>,
    entries: readonly ActionSettingsEntry[],
): readonly ActionSettingsVirtualizedSegment[] {
    const entriesById = new Map(entries.map((entry) => [entry.actionId, entry]));
    return sections.flatMap((section) => {
        const items: ActionSettingsVirtualizedItem[] = section.entries.map((entry) => ({ kind: 'action', entry }));
        for (const actionId of section.relatedActionIds ?? []) {
            const related = entriesById.get(actionId);
            if (related) items.push({ kind: 'related', entry: related });
        }

        const segments: ActionSettingsVirtualizedSegment[] = [];
        for (let start = 0; start < items.length; start += ACTION_SETTINGS_SEGMENT_SIZE) {
            const first = start === 0;
            const last = start + ACTION_SETTINGS_SEGMENT_SIZE >= items.length;
            segments.push({
                key: `${section.key}:${start}`,
                ...(section.title === undefined ? {} : { title: section.title }),
                titleKey: section.titleKey,
                ...(section.descriptionKey ? { descriptionKey: section.descriptionKey } : {}),
                items: items.slice(start, start + ACTION_SETTINGS_SEGMENT_SIZE),
                first,
                last,
            });
        }
        return segments;
    });
}

const stylesheet = StyleSheet.create((theme) => ({
    actionRightAccessory: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: Platform.select({ ios: 8, default: 10 }),
    },
    actionStatusSubtitle: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 12, default: 12 }),
        lineHeight: 16,
        marginTop: theme.space.s4,
    },
    actionConfigureIcon: {
        width: Platform.select({ ios: 24, default: 24 }),
        height: Platform.select({ ios: 24, default: 24 }),
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

function ActionSettingsRowAccessory(props: Readonly<{
    entry: ActionSettingsEntry;
    testIDPrefix: string;
    onEnabledChange: (enabled: boolean) => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View style={styles.actionRightAccessory}>
            <Switch
                testID={`${props.testIDPrefix}:enabled`}
                accessibilityLabel={props.entry.title}
                value={props.entry.enabled}
                onValueChange={props.onEnabledChange}
            />
            <View
                testID={`${props.testIDPrefix}:configure`}
                style={styles.actionConfigureIcon}
                accessibilityRole="image"
                accessibilityLabel={t('settingsActions.configureActionAccessibilityLabel')}
            >
                <Icon name="caret-right" size={16} color={theme.colors.text.secondary} />
            </View>
        </View>
    );
}

function getActionSettingsEntryStatusText(
    entry: ActionSettingsEntry,
    settings: ActionsSettingsV1,
    scmRemoteConfirmPolicy: unknown,
): string {
    const statusSummary = resolveActionSettingsEntryStatusSummary({
        settings,
        actionId: entry.actionId,
        targets: entry.targets,
        scmRemoteConfirmPolicy,
    });
    return (
        listActionSettingsEntryStatusParts(statusSummary)
            .map((part) => part.labelKey === 'settingsActions.status.allOff'
                || part.labelKey === 'settingsActions.status.destructive'
                || part.labelKey === 'settingsActions.status.external'
                ? t(part.labelKey)
                : t(part.labelKey, { partial: part.partial }))
            .join(' · ')
    );
}

export const ActionsSettingsView = React.memo(function ActionsSettingsView() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [searchQuery, setSearchQuery] = React.useState('');
    const rawSettings = useSetting('actionsSettingsV1');
    const writePolicy = useActionPolicyWriter();
    const scmRemoteConfirmPolicy = useSetting('scmRemoteConfirmPolicy');
    const voice = useSetting('voice') as Readonly<{ privacy?: { shareDeviceInventory?: boolean } }> | null;
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    // Contributed actions are machine-local daemon declarations. The shared controller may
    // initialize one verified online machine, but host actions remain account-wide.
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
    // Do not retain prior inputs through target replacement. A contribution catalog belongs to
    // precisely one daemon, so a machine switch must remove the previous machine's rows first.
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

    const settings = React.useMemo(() => normalizeActionsSettings(rawSettings), [rawSettings]);
    const availability = React.useMemo(() => ({
        executionRunsEnabled,
        memorySearchEnabled,
        voiceEnabled,
        sessionHandoffEnabled,
        voiceShareDeviceInventory: voice?.privacy?.shareDeviceInventory !== false,
    }), [executionRunsEnabled, memorySearchEnabled, voice?.privacy?.shareDeviceInventory, voiceEnabled, sessionHandoffEnabled]);

    const entries = React.useMemo(() => buildActionSettingsEntries({
        query: searchQuery,
        settings,
        availability,
        contributedActions,
        translate: t,
    }), [availability, contributedActions, searchQuery, settings]);

    // Group actions into runtime FAMILY sections (FINALIZATION-PLAN §3.3) so the user can scan and
    // configure each family (browser, simulator, plugins, local services, …) together. The per-row
    // enable toggle + per-action approval controls (detail view) are unchanged.
    const pluginTitles = React.useMemo(() => new Map(
        Object.values(daemonMergedProjection.inputs?.pluginProjectionById ?? {})
            .map((plugin) => [plugin.pluginId, plugin.title] as const),
    ), [daemonMergedProjection.inputs]);
    const familySections = React.useMemo(
        () => groupActionSettingsEntriesByFamily(entries, pluginTitles),
        [entries, pluginTitles],
    );
    const virtualizedSegments = React.useMemo(
        () => buildActionSettingsVirtualizedSegments(familySections, entries),
        [entries, familySections],
    );

    const handleActionEnabledChange = React.useCallback((actionId: ActionSettingsActionId, enabled: boolean) => {
        void writePolicy({ actionId, change: { kind: 'enabled', enabled } });
    }, [writePolicy]);

    const openActionDetails = React.useCallback((actionId: ActionSettingsActionId) => {
        router.push(`/settings/actions/${encodeURIComponent(actionId)}`);
    }, [router]);

    const renderEntryRow = React.useCallback((entry: ActionSettingsEntry) => {
        const actionTestIdPrefix = `settings-actions:action:${entry.actionId}`;
        const statusText = getActionSettingsEntryStatusText(entry, settings, scmRemoteConfirmPolicy);

        return (
            <Item
                key={entry.actionId}
                testID={actionTestIdPrefix}
                title={entry.title}
                subtitle={entry.description ?? undefined}
                subtitleAccessory={statusText ? (
                    <Text
                        testID={`${actionTestIdPrefix}:status`}
                        style={styles.actionStatusSubtitle}
                    >
                        {statusText}
                    </Text>
                ) : null}
                rightElement={(
                    <ActionSettingsRowAccessory
                        entry={entry}
                        testIDPrefix={actionTestIdPrefix}
                        onEnabledChange={(nextValue) => handleActionEnabledChange(entry.actionId, nextValue)}
                    />
                )}
                showChevron={false}
                rightElementOutsidePressable
                onPress={() => openActionDetails(entry.actionId)}
            />
        );
    }, [handleActionEnabledChange, openActionDetails, scmRemoteConfirmPolicy, settings, styles.actionStatusSubtitle]);

    const renderSegment = React.useCallback(({ item: segment }: Readonly<{ item: ActionSettingsVirtualizedSegment }>) => {
        const pluginId = segment.first && segment.items[0]?.entry.kind !== 'host'
            ? parseQualifiedPluginActionId(segment.items[0]?.entry.actionId)?.pluginId : null;
        const installedPackage = pluginId ? daemonMergedProjection.inputs?.pluginProjectionV2?.installedPackagesById[pluginId] : null;
        return (
        <ItemGroup
            title={segment.first ? segment.title ?? t(segment.titleKey) : undefined}
            titleLeading={pluginId ? <PluginMark title={segment.title ?? t(segment.titleKey)} pluginId={pluginId}
                installedPackage={installedPackage} machineId={executionTarget?.machine.id} serverId={executionTarget?.serverId}
                testID={`settings-actions:plugin:${pluginId}:mark`} /> : undefined}
            description={segment.first && segment.descriptionKey ? t(segment.descriptionKey) : undefined}
            virtualizedSegment={{ first: segment.first, last: segment.last }}
            selectableItemCountOverride={segment.items.length}
        >
            {segment.items.map((item) => item.kind === 'action'
                ? renderEntryRow(item.entry)
                : (
                    <Item
                        key={`related:${item.entry.actionId}`}
                        testID={`settings-actions:related:${item.entry.actionId}`}
                        title={item.entry.title}
                        subtitle={t('settingsActions.families.resources.related')}
                        onPress={() => openActionDetails(item.entry.actionId)}
                    />
                ))}
        </ItemGroup>
        );
    }, [daemonMergedProjection.inputs, executionTarget, openActionDetails, renderEntryRow]);

    return (
        <VirtualizedItemList
            testID="settings-actions:virtualized-list"
            data={virtualizedSegments}
            keyExtractor={(segment) => segment.key}
            renderItem={renderSegment}
            ListHeaderComponent={(
                <>
                    <SettingsPageHeader
                        description={t('settings.actionsSubtitle')}
                        actions={(
                            <MachineAdministrationTargetSelector
                                selection={administrationTargetSelection}
                                testIDPrefix="settings.actions.administration.target"
                                presentation="chip"
                            />
                        )}
                    />
                    <CompactSearchField
                        placement="page"
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder={t('settingsActions.searchPlaceholder')}
                    />
                    {virtualizedSegments.length === 0 ? (
                        <ItemGroup>
                            <Item
                                testID="settings-actions:no-results"
                                title={t('settingsActions.noResults')}
                                mode="info"
                                showChevron={false}
                            />
                        </ItemGroup>
                    ) : null}
                </>
            )}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={7}
            estimatedItemSize={560}
            recycleItems
            maintainVisibleContentPosition
        />
    );
});
