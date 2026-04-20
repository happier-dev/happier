import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

import { createDesktopActivityOverlayInteriorSurfaceStyle } from '../DesktopActivityOverlayChrome';
import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';

export function DesktopActivityOverlayCardFrame(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    testID: string;
    eyebrow?: string | null;
    title: string;
    badgeText?: string | null;
    body?: string | null;
    children?: React.ReactNode;
}>): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <View
            testID={props.testID}
            style={[
                styles.container,
                createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                    visualMode: props.visualMode,
                    kind: 'card',
                }),
            ]}
        >
            <View style={styles.header}>
                <View style={styles.titleWrap}>
                    {props.eyebrow ? (
                        <Text style={[styles.eyebrow, { color: theme.colors.overlay.textSecondary }]}>
                            {props.eyebrow}
                        </Text>
                    ) : null}
                    <Text style={[styles.title, { color: theme.colors.overlay.text }]}>
                        {props.title}
                    </Text>
                </View>
                {props.badgeText ? (
                    <View
                        style={[
                            styles.badge,
                            createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                visualMode: props.visualMode,
                                kind: 'badge',
                            }),
                        ]}
                    >
                        <Text style={[styles.badgeText, { color: theme.colors.overlay.text }]}>
                            {props.badgeText}
                        </Text>
                    </View>
                ) : null}
            </View>
            {props.body ? (
                <Text style={[styles.body, { color: theme.colors.overlay.textSecondary }]}>
                    {props.body}
                </Text>
            ) : null}
            {props.children}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        gap: 10,
        borderRadius: 18,
        paddingHorizontal: 12,
        paddingVertical: 12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
    },
    titleWrap: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    eyebrow: {
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 0.12,
        textTransform: 'uppercase',
    },
    title: {
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.08,
    },
    body: {
        fontSize: 11,
        lineHeight: 16,
    },
    badge: {
        minHeight: 20,
        paddingHorizontal: 8,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
    },
    badgeText: {
        fontSize: 9,
        fontWeight: '700',
        letterSpacing: 0.12,
        textTransform: 'uppercase',
    },
});
