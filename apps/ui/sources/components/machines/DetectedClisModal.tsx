import * as React from 'react';
import { Pressable, ScrollView } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { DetectedClisList } from '@/components/machines/DetectedClisList';
import { t } from '@/text';
import type { CustomModalInjectedProps } from '@/modal';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';


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
                ? <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                : <Icon name="arrow-clockwise" size={20} color={isOnline ? theme.colors.text.secondary : theme.colors.border.default} />}
        </Pressable>
    ), [isOnline, refresh, state.status, styles.headerActionButton, theme.colors.border.default, theme.colors.text.secondary]);

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
        dimensions: { width: 360, maxHeightRatio: 0.85 },
        scrollHost: 'body' as const,
    }), [footer, headerActions, title]);

    useModalCardChrome(setChrome, chrome);

    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.bodyContent}>
            <DetectedClisList state={state} layout="stacked" />
        </ScrollView>
    );
}
