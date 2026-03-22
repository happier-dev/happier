import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export const SessionInvalidLinkFallback = React.memo(function SessionInvalidLinkFallback() {
    return (
        <View testID="session-invalid-link" style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
            <Text style={{ textAlign: 'center', marginBottom: 8 }}>
                {t('session.invalidLinkTitle')}
            </Text>
            <Text style={{ textAlign: 'center' }}>
                {t('session.invalidLinkDescription')}
            </Text>
        </View>
    );
});

