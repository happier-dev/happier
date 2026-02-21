import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { useAutomations } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { AutomationListGroup } from '@/components/automations/list/AutomationListGroup';

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
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
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
    fab: {
        position: 'absolute',
        right: 24,
        bottom: 24,
        width: 56,
        height: 56,
        borderRadius: 28,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.fab.background,
    },
}));

export function AutomationsScreen() {
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
                        <View style={styles.emptyContainer}>
                            <Ionicons name="timer-outline" size={56} color={theme.colors.textSecondary} />
                            <Text style={styles.emptyTitle}>No automations yet</Text>
                            <Text style={styles.emptyBody}>
                                Create one from the New Session flow to run scheduled sessions on your machines.
                            </Text>
                        </View>
                    ) : (
                        <AutomationListGroup title="Automations" automations={automations} />
                    )}
                </View>
            </ItemList>
            <Pressable
                style={styles.fab}
                onPress={() => router.push('/new?automation=1&automationPicker=1' as any)}
                accessibilityRole="button"
                accessibilityLabel="Create automation"
            >
                <Ionicons name="add" size={28} color={theme.colors.fab.icon} />
            </Pressable>
        </View>
    );
}
