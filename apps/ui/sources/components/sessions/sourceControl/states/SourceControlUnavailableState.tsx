import * as React from 'react';
import { View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/StyledText';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

function sanitizeDetails(details: string | null): string | null {
    if (!details) return null;
    const trimmed = details.trim();
    if (!trimmed) return null;
    if (trimmed.includes('\n')) {
        return null;
    }
    if (/(^|\s)(fatal:|error:|remote:|hint:|usage:)/i.test(trimmed)) {
        return null;
    }
    return trimmed.length > 220 ? `${trimmed.slice(0, 220)}…` : trimmed;
}

export function SourceControlUnavailableState(props: {
    details?: string | null;
    onRetry?: () => void;
}): React.ReactElement {
    const { theme } = useUnistyles();
    const details = sanitizeDetails(props.details ?? null);

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
                {t('common.error')}
            </Text>

            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t('errors.tryAgain')}
            </Text>

            {details && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        textAlign: 'center',
                        opacity: 0.9,
                        ...Typography.default(),
                    }}
                >
                    {details}
                </Text>
            )}

            {props.onRetry && (
                <View style={{ marginTop: 6 }}>
                    <RoundButton size="normal" title={t('common.retry')} onPress={props.onRetry} />
                </View>
            )}
        </View>
    );
}
