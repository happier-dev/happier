import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SystemTaskProgressCard } from '@/components/systemTasks';
import { ActionCard } from '@/components/ui/cards/ActionCard';
import { t } from '@/text';
import type { RelayDriftBanner } from './relayDriftTypes';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create(() => ({
    container: {
        gap: 12,
    },
}));

export const RelayDriftActionCard = React.memo(function RelayDriftActionCard(props: Readonly<{
    banner: RelayDriftBanner;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const isRepairRunning = props.banner.repairTaskSnapshot != null && props.banner.repairTaskSnapshot.result == null;
    const description = props.banner.actionHint
        ? [props.banner.description, props.banner.actionHint].filter(Boolean).join('\n')
        : props.banner.description;

    return (
        <View style={styles.container}>
            <ActionCard
                testID="relay-drift-banner"
                title={props.banner.title}
                description={description}
                loading={props.banner.isRepairStarting}
                disabled={props.banner.actionDisabled || props.banner.isRepairStarting || isRepairRunning}
                icon={<Icon name="arrows-left-right" size={24} color={theme.colors.state.danger.foreground} />}
                primaryAction={{
                    label: props.banner.actionLabel,
                    onPress: props.banner.onPress,
                }}
                secondaryAction={props.banner.secondaryActionLabel && props.banner.onSecondaryPress
                    ? {
                        label: props.banner.secondaryActionLabel,
                        onPress: () => {
                            void props.banner.onSecondaryPress?.();
                        },
                    }
                    : undefined}
            />
            {props.banner.repairTaskSnapshot ? (
                <SystemTaskProgressCard
                    title={t('server.relayDrift.progressTitle')}
                    snapshot={props.banner.repairTaskSnapshot}
                    onCancel={props.banner.repairTaskSnapshot.result ? undefined : props.banner.onCancelRepair}
                />
            ) : null}
        </View>
    );
});
