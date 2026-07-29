import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';

export type BrowserSurfaceUnavailableReason =
    | 'disabled'
    | 'view_targets_disabled'
    | 'host_lost'
    | 'adapter_recovering'
    | 'live_state_lost'
    | 'unsupported_target';

export function BrowserSurfaceFallback(props: Readonly<{
    reason: BrowserSurfaceUnavailableReason;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <View
            testID={props.testID ?? `browser-surface-unavailable-${props.reason}`}
            style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                alignItems: 'center',
                justifyContent: 'center',
                padding: 24,
                backgroundColor: theme.colors.surface.base,
            }}
        >
            <Ionicons name="globe-outline" size={22} color={theme.colors.text.secondary} />
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
                {resolveReasonCopy({ reasonCode: props.reason, kind: 'browserSurface' }).message}
            </Text>
        </View>
    );
}
