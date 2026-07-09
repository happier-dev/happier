import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export function MessageActionRow(props: Readonly<{
    children: React.ReactNode;
    isWeb: boolean;
    invertTimestampAndActions: boolean;
    messageId: string;
    pointerEvents: 'auto' | 'none';
    showActions: boolean;
    timestampText: string | null;
}>): React.ReactElement {
    const hasTimestamp = typeof props.timestampText === 'string' && props.timestampText.length > 0;
    const shouldHideRow = !hasTimestamp && !props.showActions;
    return (
        <View
            {...(props.isWeb ? {} : { pointerEvents: props.pointerEvents })}
            style={[
                styles.container,
                props.invertTimestampAndActions ? styles.containerInverted : null,
                shouldHideRow ? styles.hidden : null,
                props.isWeb ? { pointerEvents: props.pointerEvents } : null,
            ]}
            testID={`transcript-message-actions-row:${props.messageId}`}
        >
            {hasTimestamp ? (
                <Text
                    testID={`transcript-message-timestamp:${props.messageId}`}
                    style={[
                        styles.timestampText,
                        props.invertTimestampAndActions ? styles.timestampTextInverted : null,
                    ]}
                >
                    {props.timestampText}
                </Text>
            ) : null}
            <View
                accessibilityElementsHidden={!props.showActions}
                importantForAccessibility={props.showActions ? 'auto' : 'no-hide-descendants'}
                style={[
                    styles.buttons,
                    !props.showActions ? styles.hidden : null,
                ]}
                testID={`transcript-message-actions:${props.messageId}`}
            >
                {props.children}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'absolute',
        right: 0,
        bottom: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    containerInverted: {
        flexDirection: 'row-reverse',
    },
    hidden: {
        opacity: 0,
    },
    buttons: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    timestampText: {
        color: theme.colors.text.tertiary,
        fontSize: 11,
        lineHeight: 16,
        marginRight: 8,
    },
    timestampTextInverted: {
        marginLeft: 12,
        marginRight: 0,
    },
}));
