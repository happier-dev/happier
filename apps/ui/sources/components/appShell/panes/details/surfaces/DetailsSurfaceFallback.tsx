import { Octicons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { DetailsSurfaceStatusV1 } from './types';

export type DetailsSurfaceFallbackStatus = DetailsSurfaceStatusV1 | 'unsupported' | 'renderer-error';

function fallbackTestId(status: DetailsSurfaceFallbackStatus): string {
    return `details-surface-fallback-${status}`;
}

function fallbackLabel(status: DetailsSurfaceFallbackStatus): string {
    if (status === 'pending') {
        return t('common.loading');
    }
    return t('session.detailsPanel.unsupportedTab');
}

export function DetailsSurfaceFallback(props: Readonly<{
    status: DetailsSurfaceFallbackStatus;
    reason?: string | null;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View
            testID={fallbackTestId(props.status)}
            style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
            }}
        >
            <Octicons name="info" size={18} color={theme.colors.text.secondary} />
            <Text
                style={{
                    marginTop: 10,
                    color: theme.colors.text.secondary,
                    fontSize: 13,
                    ...Typography.default(),
                    textAlign: 'center',
                    maxWidth: 520,
                }}
            >
                {fallbackLabel(props.status)}
            </Text>
        </View>
    );
}
