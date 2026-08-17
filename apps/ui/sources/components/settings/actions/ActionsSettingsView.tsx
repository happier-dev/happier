import * as React from 'react';
import { View, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { type ActionId, type ActionsSettingsV1 } from '@happier-dev/protocol';

import { SearchHeader } from '@/components/ui/forms/SearchHeader';
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
} from './buildActionSettingsEntries';
import { groupActionSettingsEntriesByFamily } from './groupActionSettingsEntriesByFamily';
import {
    setActionEnabled,
} from './actionSettingsTargets';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import {
    listActionSettingsEntryStatusParts,
    resolveActionSettingsEntryStatusSummary,
} from './resolveActionSettingsEntryStatusSummary';
import { useActionSettingsNarrowLayout } from './useActionSettingsNarrowLayout';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    actionRightAccessory: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: Platform.select({ ios: 8, default: 10 }),
    },
    actionStatus: {
        maxWidth: Platform.select({ ios: 128, default: 260 }),
    },
    actionStatusText: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 12, default: 12 }),
        lineHeight: 16,
    },
    actionStatusSubtitle: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 12, default: 12 }),
        lineHeight: 16,
        marginTop: Platform.select({ ios: 3, default: 2 }),
    },
    actionConfigureIcon: {
        width: Platform.select({ ios: 24, default: 24 }),
        height: Platform.select({ ios: 24, default: 24 }),
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyState: {
        paddingHorizontal: Platform.select({ ios: 16, default: 14 }),
        paddingVertical: Platform.select({ ios: 16, default: 18 }),
    },
    emptyText: {
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 15, default: 14 }),
        lineHeight: 20,
    },
}));

function ActionSettingsRowAccessory(props: Readonly<{
    entry: ActionSettingsEntry;
    compactLayout: boolean;
    statusText: string;
    testIDPrefix: string;
    onEnabledChange: (enabled: boolean) => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const shouldShowStatusInline = Boolean(props.statusText) && !props.compactLayout;

    return (
        <View style={styles.actionRightAccessory}>
            {shouldShowStatusInline ? (
                <View testID={`${props.testIDPrefix}:status-container`} style={styles.actionStatus}>
                    <Text testID={`${props.testIDPrefix}:status`} style={styles.actionStatusText} numberOfLines={1}>
                        {props.statusText}
                    </Text>
                </View>
            ) : null}
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
                <Icon name="sliders-horizontal" size={20} color={theme.colors.text.secondary} />
            </View>
        </View>
    );
}

function getActionSettingsEntryStatusText(
    entry: ActionSettingsEntry,
    settings: ActionsSettingsV1,
): string {
    const statusSummary = resolveActionSettingsEntryStatusSummary({
        settings,
        actionId: entry.actionId,
        targets: entry.targets,
    });
    return (
        listActionSettingsEntryStatusParts(statusSummary)
            .map((part) => t(part.labelKey, { count: part.count }))
            .join(' · ')
    );
}

export const ActionsSettingsView = React.memo(function ActionsSettingsView() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const styles = stylesheet;
    const compactLayout = useActionSettingsNarrowLayout();
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

    // Group actions into runtime FAMILY sections (FINALIZATION-PLAN §3.3) so the user can scan and
    // configure each family (browser, simulator, plugins, local services, …) together. The per-row
    // enable toggle + per-action approval controls (detail view) are unchanged.
    const familySections = React.useMemo(() => groupActionSettingsEntriesByFamily(entries), [entries]);

    const commitSettings = React.useCallback((next: unknown) => {
        setRawSettings(normalizeActionsSettings(next));
    }, [setRawSettings]);

    const handleActionEnabledChange = React.useCallback((actionId: ActionId, enabled: boolean) => {
        commitSettings(setActionEnabled({ settings, actionId, enabled }));
    }, [commitSettings, settings]);

    const openActionDetails = React.useCallback((actionId: ActionId) => {
        router.push(`/settings/actions/${encodeURIComponent(actionId)}`);
    }, [router]);

    const renderEntryRow = React.useCallback((entry: ActionSettingsEntry) => {
        const actionEnabled = entry.enabled;
        const actionTestIdPrefix = `settings-actions:action:${entry.actionId}`;
        const statusText = getActionSettingsEntryStatusText(entry, settings);

        return (
            <Item
                key={entry.actionId}
                testID={actionTestIdPrefix}
                title={entry.title}
                subtitle={entry.description ?? t('settingsActions.noDescription')}
                subtitleAccessory={compactLayout && statusText ? (
                    <Text
                        testID={`${actionTestIdPrefix}:status`}
                        style={styles.actionStatusSubtitle}
                        numberOfLines={1}
                    >
                        {statusText}
                    </Text>
                ) : null}
                icon={(
                    <Icon
                        name={actionEnabled ? 'lightning' : 'minus-circle'}
                        size={29}
                        color={actionEnabled ? theme.colors.state.success.foreground : theme.colors.state.danger.foreground}
                    />
                )}
                rightElement={(
                    <ActionSettingsRowAccessory
                        entry={entry}
                        compactLayout={compactLayout}
                        statusText={statusText}
                        testIDPrefix={actionTestIdPrefix}
                        onEnabledChange={(nextValue) => handleActionEnabledChange(entry.actionId, nextValue)}
                    />
                )}
                showChevron={false}
                rightElementOutsidePressable
                onPress={() => openActionDetails(entry.actionId)}
            />
        );
    }, [compactLayout, handleActionEnabledChange, openActionDetails, settings, styles.actionStatusSubtitle, theme.colors.state.danger.foreground, theme.colors.state.success.foreground]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <SearchHeader
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('settingsActions.searchPlaceholder')}
            />

            {familySections.length === 0 ? (
                <ItemGroup>
                    <View style={styles.emptyState}>
                        <Text style={styles.emptyText}>{t('settingsActions.noResults')}</Text>
                    </View>
                </ItemGroup>
            ) : null}

            {familySections.map((section, index) => (
                <ItemGroup
                    key={section.family}
                    title={t(section.titleKey)}
                    footer={index === familySections.length - 1 ? t('settingsActions.aboutFooter') : undefined}
                >
                    {section.entries.map((entry) => renderEntryRow(entry))}
                </ItemGroup>
            ))}
        </ItemList>
    );
});
