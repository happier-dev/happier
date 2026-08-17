import * as React from 'react';
import { Platform, Pressable, View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export const REVIEW_COMMENT_LINE_AFFORDANCE_TEST_ID = 'review-comment-line-affordance';
export const REVIEW_COMMENT_LINE_AFFORDANCE_ICON_TEST_ID = 'review-comment-line-affordance-icon';
export const REVIEW_COMMENT_LINE_AFFORDANCE_ICON_NAME = 'chat-dots';

const webCursorStyle = Platform.OS === 'web'
    ? ({
        cursor: 'pointer',
    } as unknown as ViewStyle)
    : null;

type PressEventWithStopImmediatePropagation = GestureResponderEvent & {
    nativeEvent?: GestureResponderEvent['nativeEvent'] & {
        stopImmediatePropagation?: () => void;
    };
};

function stopPressEventPropagation(event: GestureResponderEvent) {
    event.stopPropagation();
    (event as PressEventWithStopImmediatePropagation).nativeEvent?.stopImmediatePropagation?.();
}

export function ReviewCommentLineAffordance(props: {
    active?: boolean;
    color: string;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    onPress: (event: GestureResponderEvent) => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
    visible?: boolean;
}) {
    const active = props.active === true;
    const visible = props.visible !== false;
    const onPress = React.useCallback((event: GestureResponderEvent) => {
        stopPressEventPropagation(event);
        props.onPress(event);
    }, [props.onPress]);

    if (!visible) {
        return (
            <View
                accessibilityElementsHidden
                accessible={false}
                focusable={false}
                importantForAccessibility="no-hide-descendants"
                pointerEvents="none"
                style={[styles.button, styles.hidden, props.style]}
                testID={props.testID ?? REVIEW_COMMENT_LINE_AFFORDANCE_TEST_ID}
            />
        );
    }

    return (
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={active ? t('files.reviewComments.closeCommentA11y') : t('files.reviewComments.addCommentA11y')}
            hitSlop={8}
            onHoverIn={props.onHoverIn}
            onHoverOut={props.onHoverOut}
            onPress={onPress}
            style={[styles.button, webCursorStyle, props.style]}
            testID={props.testID ?? REVIEW_COMMENT_LINE_AFFORDANCE_TEST_ID}
        >
            <Icon
                color={props.color}
                name={active ? 'x-circle' : REVIEW_COMMENT_LINE_AFFORDANCE_ICON_NAME}
                size={14}
                testID={REVIEW_COMMENT_LINE_AFFORDANCE_ICON_TEST_ID}
            />
        </Pressable>
    );
}

const styles = StyleSheet.create(() => ({
    button: {
        width: 28,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    hidden: {
        opacity: 0,
    },
}));
