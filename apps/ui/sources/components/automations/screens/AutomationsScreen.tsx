import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { useAllMachines, useAutomations } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { layout } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AutomationListGroup } from '@/components/automations/list/AutomationListGroup';
import { AutomationsEmptyState } from '@/components/automations/shared/AutomationsEmptyState';
import { FAB } from '@/components/ui/buttons/FAB';
import { SessionGettingStartedGuidance } from '@/components/sessions/guidance/SessionGettingStartedGuidance';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
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

    const refresh = React.useCallback(async () => {
        try {
            setLoading(true);
            await sync.refreshAutomations();
        } catch (error) {
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.session.failedToLoad')
            );
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
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
                        <AutomationListGroup title={t('sessionInfo.automationsTitle')} automations={automations} />
                    )}
                </View>
            </ItemList>
            {machines.length > 0 ? (
                <FAB
                    onPress={() => deferOnWeb(() => router.push('/new?automation=1' as any))}
                />
            ) : null}
        </View>
    );
}
