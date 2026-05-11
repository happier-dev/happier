import * as React from 'react';
import { Animated, Easing, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    STATIC_MARKDOWN_RENDER_PLACEHOLDER_MAX_OPACITY,
    STATIC_MARKDOWN_RENDER_PLACEHOLDER_MIN_OPACITY,
    STATIC_MARKDOWN_RENDER_PLACEHOLDER_PULSE_MS,
} from './staticMarkdownRenderPlaceholderConfig';

export function StaticMarkdownRenderPlaceholder() {
    const opacity = React.useRef(new Animated.Value(STATIC_MARKDOWN_RENDER_PLACEHOLDER_MIN_OPACITY)).current;

    React.useEffect(() => {
        opacity.setValue(STATIC_MARKDOWN_RENDER_PLACEHOLDER_MIN_OPACITY);
        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(opacity, {
                    toValue: STATIC_MARKDOWN_RENDER_PLACEHOLDER_MAX_OPACITY,
                    duration: STATIC_MARKDOWN_RENDER_PLACEHOLDER_PULSE_MS,
                    easing: Easing.inOut(Easing.cubic),
                    useNativeDriver: true,
                }),
                Animated.timing(opacity, {
                    toValue: STATIC_MARKDOWN_RENDER_PLACEHOLDER_MIN_OPACITY,
                    duration: STATIC_MARKDOWN_RENDER_PLACEHOLDER_PULSE_MS,
                    easing: Easing.inOut(Easing.cubic),
                    useNativeDriver: true,
                }),
            ]),
        );
        animation.start();
        return () => {
            animation.stop();
        };
    }, [opacity]);

    return (
        <Animated.View
            testID="markdown-static-render-placeholder"
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.container, { opacity }]}
        >
            <View style={[styles.line, styles.lineWide]} />
            <View style={[styles.line, styles.lineMedium]} />
            <View style={[styles.line, styles.lineShort]} />
        </Animated.View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        paddingTop: 3,
        paddingBottom: 7,
    },
    line: {
        height: 14,
        borderRadius: 7,
        marginBottom: 9,
        backgroundColor: theme.colors.surface.elevated,
    },
    lineWide: {
        width: '92%',
    },
    lineMedium: {
        width: '78%',
    },
    lineShort: {
        width: '54%',
        marginBottom: 0,
    },
}));
