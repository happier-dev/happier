import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/StyledText';
import { layout } from '@/components/ui/layout/layout';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.groupped.background,
    },
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    disabledContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 24,
        gap: 10,
    },
    disabledTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
    },
    disabledBody: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
}));

export function AutomationsGate(props: { children: React.ReactNode }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const support = useAutomationsSupport();

    if (!support) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    if (!support.enabled) {
        return (
            <View style={styles.container}>
                <ItemList style={{ paddingTop: 0 }}>
                    <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                        <View style={styles.disabledContainer}>
                            <Ionicons name="timer-outline" size={56} color={theme.colors.textSecondary} />
                            <Text style={styles.disabledTitle}>Automations are disabled</Text>
                            <Text style={styles.disabledBody}>
                                Enable them from Settings, then turn on Experiments and Automations.
                            </Text>
                        </View>
                    </View>
                </ItemList>
            </View>
        );
    }

    return <>{props.children}</>;
}

