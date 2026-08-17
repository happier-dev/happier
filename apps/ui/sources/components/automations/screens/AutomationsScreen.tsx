import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAllMachines, useAutomations } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { AutomationListGroup } from '@/components/automations/list/AutomationListGroup';
import { AutomationsEmptyState } from '@/components/automations/shared/AutomationsEmptyState';
import { FAB } from '@/components/ui/buttons/FAB';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
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

    if (loading && automations.length === 0) {
        return (
            <View style={styles.loadingContainer}>
                <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            </View>
        );
    }

    if (refreshFailed && automations.length === 0) {
        return (
            <View style={styles.container}>
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
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    {refreshFailed ? (
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
                    ) : null}
                    {automations.length === 0 ? (
                        machines.length === 0 ? (
                            <SessionGettingStartedGuidance variant="primaryPane" />
                        ) : (
                            <AutomationsEmptyState
                                title={t('automations.screen.emptyTitle')}
                                body={t('automations.screen.emptyBody')}
                            />
                        )
                    ) : (
                        <AutomationListGroup
                            title={t('sessionInfo.automationsTitle')}
                            automations={automations}
                            mutationsEnabled={!refreshFailed}
                        />
                    )}
                </View>
            </ItemList>
            {machines.length > 0 ? (
                <FAB
                    onPress={() => router.push('/new?automation=1' as any)}
                    accessibilityLabel={t('automations.screen.createAutomationA11y')}
                />
            ) : null}
        </View>
    );
}
