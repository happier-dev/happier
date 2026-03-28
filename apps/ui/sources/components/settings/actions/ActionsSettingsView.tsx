import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { View, Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getActionSpec, isActionAlwaysAutoApproved, type ActionId } from '@happier-dev/protocol';

import { SearchHeader } from '@/components/ui/forms/SearchHeader';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting, useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import {
    buildActionSettingsEntries,
    type ActionSettingsEntry,
    type ActionSettingsTargetEntry,
} from './buildActionSettingsEntries';
import { buildActionSettingsDisplayModel } from './buildActionSettingsDisplayModel';
import {
    getActionSettingsTargetDefinition,
    getActionTargetApprovalRequired,
    setActionEnabled,
    setActionTargetApprovalRequired,
    setActionTargetSelected,
} from './actionSettingsTargets';
import { normalizeActionsSettings } from './normalizeActionsSettings';

const stylesheet = StyleSheet.create((theme) => ({
    targetsContainer: {
        paddingHorizontal: Platform.select({ ios: 16, default: 14 }),
        paddingVertical: Platform.select({ ios: 14, default: 16 }),
        gap: 16,
    },
    section: {
        gap: 10,
    },
    sectionTitle: {
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 13, default: 13 }),
        lineHeight: 18,
        textTransform: 'uppercase',
        fontWeight: Platform.select({ ios: '500', default: '600' }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.2 }),
    },
    emptyState: {
        paddingHorizontal: Platform.select({ ios: 16, default: 14 }),
        paddingVertical: Platform.select({ ios: 16, default: 18 }),
    },
    emptyText: {
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
    },
    unavailableSummary: {
        paddingHorizontal: Platform.select({ ios: 16, default: 14 }),
        paddingVertical: Platform.select({ ios: 14, default: 16 }),
        gap: 14,
    },
    approvalToggleRow: {
        paddingTop: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
    },
    approvalToggleLabel: {
        color: theme.colors.textSecondary,
        fontSize: Platform.select({ ios: 13, default: 13 }),
        lineHeight: 18,
    },
}));

function buildTileSubtitle(target: ActionSettingsTargetEntry): string {
    if (target.reasonKey) {
        return t(target.reasonKey);
    }
    return t(target.subtitleKey);
}

export const ActionsSettingsView = React.memo(function ActionsSettingsView() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [searchQuery, setSearchQuery] = React.useState('');
    const [rawSettings, setRawSettings] = useSettingMutable('actionsSettingsV1');
    const voice = useSetting('voice') as Readonly<{ privacy?: { shareDeviceInventory?: boolean } }> | null;
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    const mcpServersEnabled = useFeatureEnabled('mcp.servers');

    const settings = React.useMemo(() => normalizeActionsSettings(rawSettings), [rawSettings]);
    const availability = React.useMemo(() => ({
        executionRunsEnabled,
        memorySearchEnabled,
        voiceEnabled,
        sessionHandoffEnabled,
        mcpServersEnabled,
        voiceShareDeviceInventory: voice?.privacy?.shareDeviceInventory !== false,
    }), [executionRunsEnabled, memorySearchEnabled, voice?.privacy?.shareDeviceInventory, voiceEnabled, sessionHandoffEnabled, mcpServersEnabled]);

    const entries = React.useMemo(() => buildActionSettingsEntries({
        query: searchQuery,
        settings,
        availability,
        translate: t,
    }), [availability, searchQuery, settings]);
    const displayModel = React.useMemo(() => buildActionSettingsDisplayModel(entries), [entries]);

    const commitSettings = React.useCallback((next: unknown) => {
        setRawSettings(normalizeActionsSettings(next));
    }, [setRawSettings]);

    const handleActionEnabledChange = React.useCallback((actionId: ActionId, enabled: boolean) => {
        commitSettings(setActionEnabled({ settings, actionId, enabled }));
    }, [commitSettings, settings]);

    const handleSectionSelectionChange = React.useCallback((entry: ActionSettingsEntry, targets: readonly ActionSettingsTargetEntry[], nextSelectedIds: string[]) => {
        let nextSettings = settings;
        const selectedSet = new Set(nextSelectedIds);

        for (const target of targets) {
            const nextSelected = selectedSet.has(target.id);
            if (nextSelected === target.selected) {
                continue;
            }
            nextSettings = setActionTargetSelected({
                settings: nextSettings,
                actionId: entry.actionId,
                targetId: target.id,
                selected: nextSelected,
            });
        }

        commitSettings(nextSettings);
    }, [commitSettings, settings]);

    const handleApprovalRequiredChange = React.useCallback((actionId: ActionId, targetId: ActionSettingsTargetEntry['id'], approvalRequired: boolean) => {
        commitSettings(setActionTargetApprovalRequired({
            settings,
            actionId,
            targetId,
            approvalRequired,
        }));
    }, [commitSettings, settings]);

    const buildUnavailableTargetsSubtitle = React.useCallback((targets: readonly ActionSettingsTargetEntry[]) => {
        const targetTitles = targets.map((target) => t(target.titleKey)).join(', ');
        const reasons = Array.from(new Set(
            targets
                .map((target) => target.reasonKey)
                .filter((reasonKey): reasonKey is NonNullable<typeof reasonKey> => Boolean(reasonKey))
                .map((reasonKey) => t(reasonKey)),
        ));

        if (reasons.length === 0) {
            return targetTitles;
        }

        return `${targetTitles}. ${reasons.join(' ')}`;
    }, []);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SearchHeader
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('settingsActions.searchPlaceholder')}
            />

            <ItemGroup title={t('common.actions')} footer={t('settingsActions.aboutFooter')}>
                <Item
                    title={t('settings.about')}
                    subtitle={t('settingsActions.aboutSubtitle')}
                    icon={<Ionicons name="information-circle-outline" size={29} color={theme.colors.textSecondary} />}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>

            {displayModel.entries.length === 0 ? (
                <ItemGroup>
                    <View style={styles.emptyState}>
                        <Text style={styles.emptyText}>{t('settingsActions.noResults')}</Text>
                    </View>
                </ItemGroup>
            ) : null}

            {displayModel.entries.map((entry) => {
                const actionEnabled = entry.enabled;
                const actionTestIdPrefix = `settings-actions:action:${entry.actionId}`;

                return (
                    <ItemGroup key={entry.actionId} footer={entry.actionId}>
                        <Item
                            testID={actionTestIdPrefix}
                            title={entry.title}
                            subtitle={entry.description ?? t('settingsActions.noDescription')}
                            detail={actionEnabled ? t('common.enabled') : t('common.disabled')}
                            icon={(
                                <Ionicons
                                    name={actionEnabled ? 'flash-outline' : 'flash-off-outline'}
                                    size={29}
                                    color={actionEnabled ? theme.colors.success : theme.colors.warningCritical}
                                />
                            )}
                            rightElement={(
                                <Switch
                                    testID={`${actionTestIdPrefix}:enabled`}
                                    value={actionEnabled}
                                    onValueChange={(nextValue) => handleActionEnabledChange(entry.actionId, nextValue)}
                                />
                            )}
                            showChevron={false}
                            onPress={() => handleActionEnabledChange(entry.actionId, !actionEnabled)}
                        />

                        {entry.sections.length > 0 ? (
                            <View style={styles.targetsContainer}>
                                {entry.sections.map((section) => (
                                    <View key={section.id} style={styles.section}>
                                        <Text style={styles.sectionTitle}>{t(section.titleKey)}</Text>
                                        <SelectionTiles
                                            selectionMode="multiple"
                                            testIdPrefix={`${actionTestIdPrefix}:target`}
                                            options={section.targets.map((target) => ({
                                                id: target.id,
                                                title: t(target.titleKey),
                                                subtitle: buildTileSubtitle(target),
                                                icon: target.icon as React.ComponentProps<typeof Ionicons>['name'],
                                            }))}
                                            value={section.selectedIds}
                                            onChange={(nextValue) => handleSectionSelectionChange(entry, section.targets, nextValue)}
                                            renderOptionFooter={({ option, selected }) => {
                                                if (!selected) {
                                                    return null;
                                                }

                                                const definition = getActionSettingsTargetDefinition(entry.actionId, option.id);
                                                if (definition.kind !== 'surface') {
                                                    return null;
                                                }

                                                if (isActionAlwaysAutoApproved(entry.actionId)) {
                                                    return null;
                                                }

                                                const approvalRequired = getActionTargetApprovalRequired({
                                                    settings,
                                                    actionId: entry.actionId,
                                                    targetId: option.id,
                                                });

                                                return (
                                                    <Pressable
                                                        onPress={(event) => {
                                                            if (typeof (event as any)?.stopPropagation === 'function') {
                                                                (event as any).stopPropagation();
                                                            }
                                                        }}
                                                    >
                                                        <View style={styles.approvalToggleRow}>
                                                            <Text style={styles.approvalToggleLabel}>
                                                                {t('settingsActions.requireApproval')}
                                                            </Text>
                                                            <Switch
                                                                compact
                                                                testID={`${actionTestIdPrefix}:target:${option.id}:require-approval`}
                                                                value={approvalRequired}
                                                                onValueChange={(nextValue) => handleApprovalRequiredChange(entry.actionId, option.id, nextValue)}
                                                            />
                                                        </View>
                                                    </Pressable>
                                                );
                                            }}
                                        />
                                    </View>
                                ))}
                            </View>
                        ) : null}
                    </ItemGroup>
                );
            })}

            {displayModel.unavailableEntries.length > 0 ? (
                <ItemGroup title={t('settingsActions.badges.unavailable')}>
                    <View style={styles.unavailableSummary}>
                        {displayModel.unavailableEntries.map((entry) => (
                            <Item
                                key={`unavailable-${entry.actionId}`}
                                title={entry.title}
                                subtitle={buildUnavailableTargetsSubtitle(entry.targets)}
                                icon={<Ionicons name="eye-off-outline" size={29} color={theme.colors.textSecondary} />}
                                mode="info"
                                showChevron={false}
                            />
                        ))}
                    </View>
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});
