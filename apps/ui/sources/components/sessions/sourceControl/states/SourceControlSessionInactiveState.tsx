import * as React from 'react';
import { View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export function SourceControlSessionInactiveState(props: {
    machineReachable: boolean;
    onOpenSession?: () => void;
}): React.ReactElement {
    const { theme } = useUnistyles();
    const titleKey = props.machineReachable ? 'session.inactiveResumable' : 'session.inactiveMachineOffline';
    const subtitleKey = props.machineReachable ? 'errors.tryAgain' : 'session.machineOfflineCannotResume';

    return (
        <View
            style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                paddingTop: 40,
                paddingHorizontal: 20,
                gap: 14,
            }}
        >
            <Octicons name="alert" size={42} color={theme.colors.textSecondary} />

            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t(titleKey)}
            </Text>

            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t(subtitleKey)}
            </Text>

            {props.onOpenSession && (
                <View style={{ marginTop: 6 }}>
                    <RoundButton size="normal" title={t('common.continue')} onPress={props.onOpenSession} />
                </View>
            )}
        </View>
    );
}
