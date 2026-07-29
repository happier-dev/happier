import * as React from 'react';
import {
    AccessibilityInfo,
    Platform,
    StyleSheet,
    View,
} from 'react-native';

import { Text } from '@/components/ui/text/Text';

export const ExternalSessionOperationAccessibilityStatus = React.memo(
    function ExternalSessionOperationAccessibilityStatus(props: Readonly<{
        announcement: string;
        statusTestID: string;
        transitionKey: string;
    }>) {
        const lastIosTransitionRef = React.useRef<string | null>(null);

        React.useEffect(() => {
            if (
                Platform.OS !== 'ios'
                || lastIosTransitionRef.current === props.transitionKey
            ) {
                return;
            }
            lastIosTransitionRef.current = props.transitionKey;
            try {
                AccessibilityInfo.announceForAccessibility(props.announcement);
            } catch {
                // Accessibility announcements are best effort on native platforms.
            }
        }, [props.announcement, props.transitionKey]);

        if (Platform.OS === 'ios') return null;
        return (
            <View
                testID={props.statusTestID}
                accessible
                accessibilityLiveRegion="polite"
                pointerEvents="none"
                style={styles.status}
                {...({
                    role: 'status',
                    'aria-live': 'polite',
                    'aria-atomic': true,
                } as Record<string, unknown>)}
            >
                <Text>{props.announcement}</Text>
            </View>
        );
    },
);

const styles = StyleSheet.create({
    status: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
});
