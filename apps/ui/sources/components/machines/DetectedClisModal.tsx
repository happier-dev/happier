import * as React from 'react';
import { Pressable, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { DetectedClisList } from '@/components/machines/DetectedClisList';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';


type Props = CustomModalInjectedProps & {
    machineId: string;
    isOnline: boolean;
    serverId?: string | null;
};

const stylesheet = StyleSheet.create((theme) => ({
    bodyContent: {
        paddingVertical: 4,
    },
    headerActionButton: {
        padding: 2,
    },
}));

export function DetectedClisModal({ onClose, setChrome, machineId, isOnline, serverId }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const title = t('machine.detectedClis');

    const { state, refresh } = useDaemonScopedMachineCapabilitiesCache({
        machineId,
        serverId,
        // Cache-first: never auto-fetch on mount; user can explicitly refresh.
        enabled: false,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
    });

    const headerActions = React.useMemo(() => (
        <Pressable
            testID="detected-clis:refresh"
            onPress={() => refresh({ bypassCache: true })}
            hitSlop={10}
            style={styles.headerActionButton}
            accessibilityRole="button"
            accessibilityLabel={t('common.refresh')}
            disabled={!isOnline || state.status === 'loading'}
        >
            {state.status === 'loading'
                ? <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                : <Ionicons name="refresh" size={20} color={isOnline ? theme.colors.textSecondary : theme.colors.divider} />}
        </Pressable>
    ), [isOnline, refresh, state.status, styles.headerActionButton, theme.colors.divider, theme.colors.textSecondary]);

    const footer = React.useMemo(() => (
        <RoundButton testID="detected-clis:ok" title={t('common.ok')} size="normal" onPress={onClose} />
    ), [onClose]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title,
        testID: 'detected-clis:modal',
        closeButtonTestID: 'detected-clis:close',
        actions: headerActions,
        footer,
        layout: 'fill' as const,
        dimensions: { width: 360, maxHeightRatio: 0.85 },
    }), [footer, headerActions, title]);

    useModalCardChrome(setChrome, chrome);

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.bodyContent}>
            <DetectedClisList state={state} layout="stacked" />
        </ScrollView>
    );
}
