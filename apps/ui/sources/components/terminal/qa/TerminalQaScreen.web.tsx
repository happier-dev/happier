import * as React from 'react';
import { View } from 'react-native';

import { isDevRouteEnabled } from '@/auth/routing/devRoutePolicy';
import { Text } from '@/components/ui/text/Text';

export function TerminalQaScreen(): React.ReactElement | null {
    if (!isDevRouteEnabled()) return null;
    return (
        <View testID="terminal-qa-native-required" style={{ flex: 1, padding: 24 }}>
            <Text>TERM loaded-device QA is available only in native iOS and Android development builds.</Text>
        </View>
    );
}

export default TerminalQaScreen;
