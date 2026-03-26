import * as React from 'react';
import { View, Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { DetectedClisList } from '@/components/machines/DetectedClisList';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { Text } from '@/components/ui/text/Text';


type Props = CustomModalInjectedProps & {
    machineId: string;
    isOnline: boolean;
    serverId?: string | null;
};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 360,
        maxWidth: '92%',
        maxHeight: '85%',
        flexShrink: 1,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    body: {
        flexGrow: 1,
    },
    bodyContent: {
        paddingVertical: 4,
    },
    footer: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        alignItems: 'center',
    },
}));

export function DetectedClisModal({ onClose, machineId, isOnline, serverId }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const { state, refresh } = useDaemonScopedMachineCapabilitiesCache({
        machineId,
        serverId,
        // Cache-first: never auto-fetch on mount; user can explicitly refresh.
        enabled: false,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
    });

    return (
        <View style={styles.container} testID="detected-clis:modal">
            <View style={styles.header}>
                <Text style={styles.title}>{t('machine.detectedClis')}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <Pressable
                        testID="detected-clis:refresh"
                        onPress={() => refresh({ bypassCache: true })}
                        hitSlop={10}
                        style={{ padding: 2 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.refresh')}
                        disabled={!isOnline || state.status === 'loading'}
                    >
                        {state.status === 'loading'
                            ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            : <Ionicons name="refresh" size={20} color={isOnline ? theme.colors.textSecondary : theme.colors.divider} />}
                    </Pressable>
                    <Pressable
                        testID="detected-clis:close"
                        onPress={() => onClose()}
                        hitSlop={10}
                        style={{ padding: 2 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.close')}
                    >
                        <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
                    </Pressable>
                </View>
            </View>

            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
                <DetectedClisList state={state} layout="stacked" />
            </ScrollView>

            <View style={styles.footer}>
                <RoundButton testID="detected-clis:ok" title={t('common.ok')} size="normal" onPress={onClose} />
            </View>
        </View>
    );
}
