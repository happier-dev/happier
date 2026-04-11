import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';

export const PaneLoadingFallback = React.memo((props: Readonly<{
    color: string;
    paddingTop?: number;
    paddingHorizontal?: number;
    showTypographyMetrics?: boolean;
}>) => {
    const textStyle = props.showTypographyMetrics === false
        ? undefined
        : Typography.default();

    return (
        <View
            style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                paddingTop: props.paddingTop ?? 24,
                paddingHorizontal: props.paddingHorizontal ?? 16,
            }}
        >
            <ActivityIndicator size="small" color={props.color} />
            <Text style={{ marginTop: 10, fontSize: 12, color: props.color, ...textStyle }}>
                {t('common.loading')}
            </Text>
        </View>
    );
});
