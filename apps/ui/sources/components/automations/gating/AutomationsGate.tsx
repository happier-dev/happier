import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAutomationsSupport } from '@/hooks/server/useAutomationsSupport';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.background.canvas,
    },
    container: {
        flex: 1,
        backgroundColor: theme.colors.background.canvas,
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
        color: theme.colors.text.primary,
    },
    disabledBody: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));

export function AutomationsGate(props: { children: React.ReactNode }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const support = useAutomationsSupport();

    if (!support || support.loading) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="small" color={theme.colors.text.secondary} />
            </View>
        );
    }

    if (!support.enabled) {
        return (
            <View style={styles.container}>
                <ItemList style={{ paddingTop: 0 }}>
                    <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
	                        <View style={styles.disabledContainer}>
	                            <Ionicons name="timer-outline" size={56} color={theme.colors.text.secondary} />
	                            <Text style={styles.disabledTitle}>{t('automations.gate.disabledTitle')}</Text>
	                            <Text style={styles.disabledBody}>
	                                {t('automations.gate.disabledBody')}
	                            </Text>
	                        </View>
                    </View>
                </ItemList>
            </View>
        );
    }

    return <>{props.children}</>;
}
