import * as React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import type { DesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import { Text } from '@/components/ui/text/Text';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';

export function DesktopActivityOverlayCollapsed(props: Readonly<{
    model: DesktopActivityOverlayModel;
    compactStyle: 'pill' | 'panel';
    interactive: boolean;
    dragHandlers: Readonly<Record<string, unknown>>;
    onPress: () => void;
    onHoverIn?: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const containerStyle = [
        styles.container,
        props.compactStyle === 'pill' ? styles.pill : styles.panel,
        {
            backgroundColor: theme.colors.overlay.scrim,
            borderColor: theme.colors.divider,
            ...(createBackdropWebStyle({
                backgroundColor: theme.colors.overlay.scrim,
                blurPx: 16,
            }) as object),
        },
    ];

    return (
        <Pressable
            testID="desktop-activity-overlay-collapsed"
            disabled={!props.interactive}
            onPress={props.onPress}
            onHoverIn={props.onHoverIn}
            style={({ pressed }) => [
                containerStyle,
                props.interactive && pressed ? { opacity: 0.92 } : null,
            ]}
            {...props.dragHandlers}
        >
            <View style={styles.textContainer}>
                <Text style={[styles.title, { color: theme.colors.overlay.text }]}>
                    {props.model.collapsed.title}
                </Text>
                {props.model.collapsed.statusText ? (
                    <Text style={[styles.status, { color: theme.colors.overlay.text }]}>
                        {props.model.collapsed.statusText}
                    </Text>
                ) : null}
            </View>
            {typeof props.model.collapsed.sessionCount === 'number' ? (
                <View style={[styles.countBadge, { backgroundColor: theme.colors.button.primary.background }]}>
                    <Text style={[styles.countText, { color: theme.colors.button.primary.tint }]}>
                        {String(props.model.collapsed.sessionCount)}
                    </Text>
                </View>
            ) : null}
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        minHeight: 54,
        borderWidth: StyleSheet.hairlineWidth,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    panel: {
        borderRadius: 14,
    },
    pill: {
        borderRadius: 999,
    },
    textContainer: {
        flexShrink: 1,
        minWidth: 0,
        gap: 2,
    },
    title: {
        fontSize: 14,
        fontWeight: '700',
    },
    status: {
        fontSize: 12,
        opacity: 0.9,
    },
    countBadge: {
        minWidth: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
    },
    countText: {
        fontSize: 12,
        fontWeight: '700',
    },
});
