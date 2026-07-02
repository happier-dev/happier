import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

export function PluginReactNativeUnavailable(): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View
            testID="plugin-rn-ui-unavailable"
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}
        >
            <Text style={{ color: theme.colors.text.secondary, fontSize: 13, ...Typography.default(), textAlign: 'center' }}>
                {t('common.unavailable')}
            </Text>
        </View>
    );
}
