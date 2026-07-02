import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Platform, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { type ActionId, listActionSpecs } from '@happier-dev/protocol';

import { SearchHeader } from '@/components/ui/forms/SearchHeader';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemInfoNotice } from '@/components/ui/lists/ItemInfoNotice';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
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
    type ActionSettingsEntry,
    type ActionSettingsTargetEntry,
} from './buildActionSettingsEntries';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import { useActionSettingsNarrowLayout } from './useActionSettingsNarrowLayout';

const categoryOrder: readonly ActionSettingsTargetCategory[] = ['app', 'voice', 'integrations'];

const stylesheet = StyleSheet.create((theme) => ({
    screen: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
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

function getSearchParamValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

function decodeActionIdParam(value: string | string[] | undefined): ActionId | null {
    const raw = getSearchParamValue(value);
    if (!raw) {
        return null;
    }

    const decoded = decodeURIComponent(raw);
    return listActionSpecs().some((spec) => spec.id === decoded) ? (decoded as ActionId) : null;
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
    actionId: ActionId;
}>;

export const ActionSettingsDetailContent = React.memo(function ActionSettingsDetailContent(props: ActionSettingsDetailContentProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const compactLayout = useActionSettingsNarrowLayout();
    const [searchQuery, setSearchQuery] = React.useState('');
    const [rawSettings, setRawSettings] = useSettingMutable('actionsSettingsV1');
    const settings = React.useMemo(() => normalizeActionsSettings(rawSettings), [rawSettings]);
    const voiceSettings = useSetting('voice') as Readonly<{ privacy?: { shareDeviceInventory?: boolean } }> | null;
    const executionRunsEnabled = useFeatureEnabled('execution.runs');
    const memorySearchEnabled = useFeatureEnabled('memory.search');
    const voiceEnabled = useFeatureEnabled('voice');
    const sessionHandoffEnabled = useFeatureEnabled('sessions.handoff');
    const mcpServersEnabled = useFeatureEnabled('mcp.servers');
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
            translate: t,
        });
        return entries.find((candidate) => candidate.actionId === props.actionId) ?? null;
    }, [availability, props.actionId, settings]);
    const filteredTargets = React.useMemo(() => (
        entry?.targets.filter((target) => targetMatchesSearch(target, searchQuery)) ?? []
    ), [entry?.targets, searchQuery]);
    const targetSections = React.useMemo(() => groupTargetsByCategory(filteredTargets), [filteredTargets]);
    const toolExposureTargets = React.useMemo(() => (
        filteredTargets
            .map((target) => {
                const available = target.state !== 'unavailable';
                const exposureState = entry
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
            value,
        }));
    }, [commitSettings, props.actionId, settings]);

    const handleToolExposureChange = React.useCallback((
        target: ActionSettingsTargetEntry,
        value: ActionSettingsToolExposureControlValue,
    ) => {
        commitSettings(setActionSettingsToolExposureMode({
            settings,
            actionId: props.actionId,
            targetId: target.id,
            value,
        }));
    }, [commitSettings, props.actionId, settings]);

    if (!entry) {
        return (
            <ItemList>
                <ItemGroup>
                    <Item
                        title={t('settingsActions.invalidActionTitle')}
                        subtitle={t('settingsActions.invalidActionSubtitle')}
                        icon={<Ionicons name="warning-outline" size={29} color={theme.colors.text.secondary} />}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <View style={styles.screen}>
            <SearchHeader
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('settingsActions.detailSearchPlaceholder')}
            />

            <ItemList>
                <ItemGroup>
                    <Item
                        testID={`settings-actions:action:${entry.actionId}:summary`}
                        title={entry.title}
                        subtitle={entry.description ?? t('settingsActions.noDescription')}
                        detail={entry.enabled ? t('common.enabled') : t('common.disabled')}
                        icon={(
                            <Ionicons
                                name={entry.enabled ? 'flash-outline' : 'flash-off-outline'}
                                size={29}
                                color={entry.enabled ? theme.colors.state.success.foreground : theme.colors.state.danger.foreground}
                            />
                        )}
                        mode="info"
                        showChevron={false}
                        rightElement={(
                            <Switch
                                testID={`settings-actions:action:${entry.actionId}:enabled`}
                                value={entry.enabled}
                                onValueChange={handleActionEnabledChange}
                            />
                        )}
                    />
                </ItemGroup>

                <ItemInfoNotice
                    testID="settings-actions:approval-mode-help"
                    title={t('settingsActions.approvalHelpTitle')}
                    body={t('settingsActions.approvalHelpBody')}
                />

                {targetSections.length === 0 ? (
                    <ItemGroup>
                        <View style={styles.emptyState}>
                            <Text style={styles.emptyText}>{t('settingsActions.noTargetsMatch')}</Text>
                        </View>
                    </ItemGroup>
                ) : null}

                {targetSections.map((section) => (
                    <ItemGroup key={section.category} title={t(getCategoryTitleKey(section.category))}>
                        {section.targets.map((target) => {
                            const targetTestIDPrefix = `settings-actions:action:${entry.actionId}:target:${target.id}`;
                            const available = target.state !== 'unavailable';
                            const controlState = resolveActionSettingsTargetControlState({
                                settings,
                                actionId: entry.actionId,
                                targetId: target.id,
                                available,
                            });
                            const shouldStackModeControl = compactLayout && controlState.kind === 'approval';
                            const targetModeControl = (
                                <ActionSettingsTargetModeControl
                                    testIDPrefix={targetTestIDPrefix}
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
                                    icon={<Ionicons name={target.icon as React.ComponentProps<typeof Ionicons>['name']} size={29} color={theme.colors.text.secondary} />}
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

                {toolExposureTargets.length > 0 ? (
                    <ItemGroup
                        title={t('settingsActions.toolExposure.title')}
                        footer={t('settingsActions.toolExposure.footer')}
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
            </ItemList>
        </View>
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
                    <ItemGroup>
                        <Item
                            title={invalidActionTitle}
                            subtitle={t('settingsActions.invalidActionSubtitle')}
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
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
