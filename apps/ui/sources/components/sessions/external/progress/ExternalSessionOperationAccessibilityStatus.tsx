import * as React from 'react';
import {
    Platform,
    StyleSheet,
    View,
} from 'react-native';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
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
            // The transition is recorded even when nothing is spoken, so a silent
            // state between two identical messages does not swallow the second one.
            lastIosTransitionRef.current = props.transitionKey;
            // Canonical imperative announcer: it already drops an empty message —
            // announcing one only interrupts whatever VoiceOver is reading — and
            // swallows best-effort platform failures.
            announceAccessibilityMessage(props.announcement);
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
