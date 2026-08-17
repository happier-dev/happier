import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { browserFrameStyles } from './styles';

export function BrowserFrameLoading(props: Readonly<{
    testID: string;
}>): React.ReactElement {
    return (
        <View
            testID={`${props.testID}-loading`}
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            role="status"
            aria-live="polite"
            style={browserFrameStyles.centered}
        >
            <Text style={browserFrameStyles.statusText}>{t('common.loading')}</Text>
        </View>
    );
}
