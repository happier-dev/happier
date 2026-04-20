import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

import { createDesktopActivityOverlayInteriorSurfaceStyle } from '../DesktopActivityOverlayChrome';
import type { DesktopActivityOverlayHoverablePressableState } from '../DesktopActivityOverlayHoverablePressableState';
import type { DesktopActivityOverlayVisualMode } from '../DesktopActivityOverlayVisualMode';
import type { DesktopActivityOverlayActionDescriptor } from '../shared/desktopActivityOverlayUiModel';
import {
    resolveDesktopActivityOverlayCardActionInstanceTestID,
    resolveDesktopActivityOverlayCardActionKindTestID,
} from '../shared/desktopActivityOverlaySelectors.mjs';

function resolveActionPalette(
    theme: ReturnType<typeof useUnistyles>['theme'],
    tone: DesktopActivityOverlayActionDescriptor['tone'],
): Readonly<{
    backgroundColor: string;
    color: string;
}> {
    switch (tone) {
        case 'primary':
            return {
                backgroundColor: theme.colors.overlay.text,
                color: theme.colors.text,
            };
        case 'danger':
            return {
                backgroundColor: theme.colors.permissionButton.deny.background,
                color: theme.colors.permissionButton.deny.text,
            };
        case 'secondary':
        default:
            return {
                backgroundColor: 'transparent',
                color: theme.colors.overlay.text,
            };
    }
}

export function DesktopActivityOverlayCardActions(props: Readonly<{
    visualMode: DesktopActivityOverlayVisualMode;
    cardId: string;
    actions: readonly DesktopActivityOverlayActionDescriptor[];
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();

    if (props.actions.length === 0) {
        return null;
    }

    return (
        <View style={styles.container}>
            {props.actions.map((action) => {
                const palette = resolveActionPalette(theme, action.tone);

                return (
                    <View
                        key={action.id}
                        testID={resolveDesktopActivityOverlayCardActionKindTestID(action.id)}
                        style={styles.actionItem}
                    >
                        <Pressable
                            accessibilityLabel={action.accessibilityLabel ?? action.label}
                            testID={resolveDesktopActivityOverlayCardActionInstanceTestID(props.cardId, action.id)}
                            onPress={() => props.onAction?.(action)}
                            style={(state) => {
                                const hovered = (state as DesktopActivityOverlayHoverablePressableState).hovered === true;

                                return [
                                    styles.button,
                                    createDesktopActivityOverlayInteriorSurfaceStyle(theme, {
                                        visualMode: props.visualMode,
                                        kind: action.tone === 'secondary' ? 'badge' : 'card',
                                    }),
                                    action.tone !== 'secondary' ? { backgroundColor: palette.backgroundColor } : null,
                                    hovered ? { opacity: 0.98 } : null,
                                    state.pressed ? { opacity: 0.9 } : null,
                                ];
                            }}
                        >
                            <Text style={[styles.buttonText, { color: palette.color }]}>
                                {action.label}
                            </Text>
                        </Pressable>
                    </View>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    actionItem: {
        flex: 1,
    },
    button: {
        flex: 1,
        minHeight: 34,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonText: {
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.08,
    },
});
