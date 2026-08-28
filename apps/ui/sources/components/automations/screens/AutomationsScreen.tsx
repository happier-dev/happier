import React from 'react';
import { Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAllMachines, useAutomations } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { AutomationListGroup } from '@/components/automations/list/AutomationListGroup';
import { useAutomationRunNowController } from '@/components/automations/list/useAutomationRunNowController';
import { AutomationsEmptyState } from '@/components/automations/shared/AutomationsEmptyState';
import { FAB } from '@/components/ui/buttons/FAB';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveNewSessionDraftRouteIdentity } from '@/components/sessions/new/navigation/newSessionDraftRouteIdentity';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';

/**
 * Accounts can contain high-cardinality Automation catalogs, so the screen
 * renders chunks through the canonical virtualized list instead of
 * instantiating every row. Chunking keeps one logical grouped surface via
 * `virtualizedSegment` rather than introducing a second list presentation.
 */
const AUTOMATION_ROWS_PER_CHUNK = 8;

type AutomationsScreenRow =
    | Readonly<{ kind: 'refreshError'; key: string }>
    | Readonly<{
        kind: 'automationChunk';
        key: string;
        automations: ReadonlyArray<ReturnType<typeof useAutomations>[number]>;
        first: boolean;
        last: boolean;
    }>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
    },
    row: {
        maxWidth: layout.maxWidth,
        alignSelf: 'center',
        width: '100%',
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export function AutomationsScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const automations = useAutomations();
    const machines = useAllMachines();
    const [loading, setLoading] = React.useState(true);
    const [refreshFailed, setRefreshFailed] = React.useState(false);
    const runNow = useAutomationRunNowController();
    const mountedRef = React.useRef(true);
    React.useEffect(() => () => {
        mountedRef.current = false;
    }, []);
    const isInvocationCurrent = React.useCallback(() => mountedRef.current, []);

    const refresh = React.useCallback(async () => {
        try {
            setLoading(true);
            setRefreshFailed(false);
            await sync.refreshAutomations();
        } catch {
            setRefreshFailed(true);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const rows = React.useMemo<readonly AutomationsScreenRow[]>(() => {
        const next: AutomationsScreenRow[] = [];
        if (refreshFailed) next.push({ kind: 'refreshError', key: 'refresh-error' });
        for (let offset = 0; offset < automations.length; offset += AUTOMATION_ROWS_PER_CHUNK) {
            const chunk = automations.slice(offset, offset + AUTOMATION_ROWS_PER_CHUNK);
            next.push({
                kind: 'automationChunk',
                key: `automations:${chunk[0]!.id}`,
                automations: chunk,
                first: offset === 0,
                last: offset + AUTOMATION_ROWS_PER_CHUNK >= automations.length,
            });
        }
        return next;
    }, [automations, refreshFailed]);

    const automationSettingsEntry = (
        <ItemGroup>
            <Item
                testID="automations-open-settings"
                title={t('automations.settings.title')}
                subtitle={t('automations.settings.openSubtitle')}
                onPress={() => router.push('/automations/settings')}
            />
        </ItemGroup>
    );

    const renderRow = React.useCallback(({ item }: { item: AutomationsScreenRow }) => {
        if (item.kind === 'refreshError') {
            return (
                <View style={styles.row}>
                    <ItemGroup>
                        <Item
                            testID="automations-stale-refresh-error"
                            title={t('automations.session.failedToLoad')}
                            icon={<Icon name="warning" size={20} color={theme.colors.state.warning.foreground} />}
                            mode="info"
                            showChevron={false}
                            accessibilityRole="alert"
                            accessibilityLiveRegion="assertive"
                            webRole="alert"
                        />
                        <Item
                            testID="automations-stale-refresh-retry"
                            title={t('common.retry')}
                            icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.accent.blue} />}
                            onPress={() => { void refresh(); }}
                            showChevron={false}
                        />
                    </ItemGroup>
                </View>
            );
        }
        return (
            <View style={styles.row}>
                <AutomationListGroup
                    {...(item.first ? { title: t('sessionInfo.automationsTitle') } : {})}
                    automations={item.automations}
                    mutationsEnabled={!refreshFailed}
                    runNow={runNow}
                    isInvocationCurrent={isInvocationCurrent}
                    virtualizedSegment={{ first: item.first, last: item.last }}
                />
            </View>
        );
    }, [isInvocationCurrent, refresh, refreshFailed, runNow, styles.row, theme]);


    if (loading && automations.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.row}>{automationSettingsEntry}</View>
                <View style={styles.loadingContainer}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            </View>
        );
    }

    if (refreshFailed && automations.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.row}>{automationSettingsEntry}</View>
                <SurfaceStateCard
                    testID="automations-refresh-error"
                    kind="error"
                    title={t('common.error')}
                    reason={t('automations.session.failedToLoad')}
                    action={{
                        label: t('common.retry'),
                        onPress: () => { void refresh(); },
                    }}
                    accessibilitySemantics="alert"
                />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {automations.length === 0 ? (
                <View style={styles.row}>
                    {automationSettingsEntry}
                    {refreshFailed ? renderRow({ item: { kind: 'refreshError', key: 'refresh-error' } }) : null}
                    {machines.length === 0 ? (
                        <SessionGettingStartedGuidance variant="primaryPane" />
                    ) : (
                        <AutomationsEmptyState
                            title={t('automations.screen.emptyTitle')}
                            body={t('automations.screen.emptyBody')}
                        />
                    )}
                </View>
            ) : (
                <VirtualizedList
                    testID="automations-list"
                    data={rows}
                    keyExtractor={(item) => item.key}
                    renderItem={renderRow}
                    style={{ flex: 1, ...(Platform.OS === 'web' ? { minHeight: 0 } : {}) }}
                    contentContainerStyle={{ paddingBottom: Platform.OS === 'ios' ? 34 : 16 }}
                    backendPreference="auto"
                    initialNumToRender={4}
                    ListHeaderComponent={<View style={styles.row}>{automationSettingsEntry}</View>}
                />
            )}
            {machines.length > 0 ? (
                <FAB
                    onPress={() => {
                        const draftId = resolveNewSessionDraftRouteIdentity({ routeDraftId: undefined }).draftId;
                        router.push({
                            pathname: '/new',
                            params: {
                                ...buildNewSessionLaunchRouteParams({ draftId }),
                                automation: '1',
                            },
                        } as any);
                    }}
                    accessibilityLabel={t('automations.screen.createAutomationA11y')}
                />
            ) : null}
        </View>
    );
}
