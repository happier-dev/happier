import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/StyledText';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { useAutomations } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { filterAutomationsLinkedToSession } from '@/sync/domains/automations/automationSessionLink';
import { AutomationListGroup } from '@/components/automations/list/AutomationListGroup';

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
    emptyContainer: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 24,
        paddingHorizontal: 24,
        gap: 10,
    },
    emptyTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
    },
    emptyBody: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export function SessionAutomationsScreen(props: { sessionId: string }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const automations = useAutomations();
    const [loading, setLoading] = React.useState(true);

    const refresh = React.useCallback(async () => {
        try {
            setLoading(true);
            await sync.refreshAutomations();
        } catch (error) {
            await Modal.alert('Error', error instanceof Error ? error.message : 'Failed to load automations.');
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
                        <View style={styles.emptyContainer}>
                            <Ionicons name="timer-outline" size={56} color={theme.colors.textSecondary} />
                            <Text style={styles.emptyTitle}>No automations</Text>
                            <Text style={styles.emptyBody}>
                                Add an automation to queue scheduled messages into this session.
                            </Text>
                        </View>
                    ) : (
                        <AutomationListGroup title="Automations" automations={linked} />
                    )}

                    <ItemGroup title="Actions">
                        <Item
                            title="Add automation"
                            icon={<Ionicons name="add-outline" size={29} color="#007AFF" />}
                            onPress={() => router.push(`/session/${props.sessionId}/automations/new` as any)}
                        />
                    </ItemGroup>
                </View>
            </ItemList>
        </View>
    );
}
