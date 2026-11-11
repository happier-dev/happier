import * as React from 'react';
import { Platform, type StyleProp, type TextStyle } from 'react-native';

import { HAPPIER_MIDDLE_ELLIPSIS_STYLE, splitForWebMiddleEllipsis } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';

const { row: ROW_STYLE } = HAPPIER_MIDDLE_ELLIPSIS_STYLE;

/** The split is plugin-ui's, so a plugin row and a core row give up the same middle. */
export { splitForWebMiddleEllipsis };

/**
 * One line of text that gives up its middle, never its end: the web draws only a tail ellipsis, so there
 * the head shrinks with its own ellipsis and the end stays whole; native uses the platform's middle mode.
 */
export function MiddleEllipsisText(props: Readonly<{
    value: string;
    style?: StyleProp<TextStyle>;
    testID?: string;
    accessibilityRole?: 'header';
}>): React.ReactElement {
    const split = Platform.OS === 'web' ? splitForWebMiddleEllipsis(props.value) : null;
    if (!split) {
        return (
            <Text testID={props.testID} style={props.style} numberOfLines={1} ellipsizeMode="middle" accessibilityRole={props.accessibilityRole}>
                {props.value}
            </Text>
        );
    }
    return (
        <Text testID={props.testID} style={[props.style, ROW_STYLE]} accessibilityRole={props.accessibilityRole}>
            <Text style={split.headStyle} numberOfLines={1} ellipsizeMode="tail">{split.head}</Text>
            <Text style={split.tailStyle} numberOfLines={1}>{split.tail}</Text>
        </Text>
    );
}
