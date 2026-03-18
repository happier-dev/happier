import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { useAutomations, useSession, useSettings } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { filterAutomationsLinkedToSession } from '@/sync/domains/automations/automationSessionLink';
import { AutomationListGroup } from '@/components/automations/list/AutomationListGroup';
import { AutomationsEmptyState } from '@/components/automations/shared/AutomationsEmptyState';
import { getExistingSessionAutomationUnavailableReason } from '@/components/automations/shared/existingSessionAutomationAvailabilityUi';
import { resolveExistingSessionAutomationAvailability } from '@/components/automations/shared/resolveExistingSessionAutomationAvailability';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { deferOnWeb } from '@/utils/platform/deferOnWeb';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export function SessionAutomationsScreen(props: { sessionId: string }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const automations = useAutomations();
    const session = useSession(props.sessionId);
    const settings = useSettings();
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

    const linked = React.useMemo(() => {
        return filterAutomationsLinkedToSession(automations, props.sessionId);
    }, [automations, props.sessionId]);
    const sessionDekBase64 = sync.getSessionEncryptionKeyBase64ForResume(props.sessionId);
    const machineIdOverride = readMachineTargetForSession(props.sessionId)?.machineId ?? null;
    const availability = React.useMemo(() => resolveExistingSessionAutomationAvailability({
        session,
        machineIdOverride,
        sessionDekBase64,
        accountSettings: settings,
    }), [machineIdOverride, session, sessionDekBase64, settings]);
    const addAutomationUnavailableReason = React.useMemo(
        () => getExistingSessionAutomationUnavailableReason(availability),
        [availability],
    );

    if (loading) {
        return (
            <View style={styles.loading}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <ItemList style={{ paddingTop: 0 }}>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    {linked.length === 0 ? (
                        <AutomationsEmptyState
                            title={t('automations.session.emptyTitle')}
                            body={t('automations.session.emptyBody')}
                        />
                    ) : (
                        <AutomationListGroup title={t('sessionInfo.automationsTitle')} automations={linked} />
                    )}

                    <ItemGroup title={t('common.actions')}>
                        <Item
                            title={t('automations.session.addAutomation')}
                            subtitle={addAutomationUnavailableReason ?? undefined}
                            icon={<Ionicons name="add-outline" size={29} color={theme.colors.accent.blue} />}
                            onPress={() => deferOnWeb(() => router.push(`/session/${props.sessionId}/automations/new` as any))}
                            disabled={availability.kind !== 'ready'}
                        />
                    </ItemGroup>
                </View>
            </ItemList>
        </View>
    );
}
