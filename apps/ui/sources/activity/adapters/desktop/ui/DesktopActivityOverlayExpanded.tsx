import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    DesktopActivityOverlayChromeBackdrop,
    createDesktopActivityOverlayChromeStyle,
    DesktopActivityOverlayChromeHighlights,
} from './DesktopActivityOverlayChrome';
import { desktopActivityOverlayChromeMetrics } from './DesktopActivityOverlayChromeMetrics';
import {
    resolveDesktopActivityOverlaySurfaceTestID,
    type DesktopActivityOverlayVisualMode,
} from './DesktopActivityOverlayVisualMode';
import { DesktopActivityOverlayExpandedCards } from './cards/DesktopActivityOverlayExpandedCards';
import type {
    DesktopActivityOverlayActionDescriptor,
    DesktopActivityOverlayUiModel,
} from './shared/desktopActivityOverlayUiModel';

export function DesktopActivityOverlayExpanded(props: Readonly<{
    model: DesktopActivityOverlayUiModel;
    visualMode: DesktopActivityOverlayVisualMode;
    onCollapse: () => void;
    onOpenSession: (sessionId: string) => void;
    onOpenInbox: () => void;
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const surfaceTestID = resolveDesktopActivityOverlaySurfaceTestID('desktop-activity-overlay-expanded', props.visualMode);

    return (
        <Pressable
            testID="desktop-activity-overlay-expanded"
            accessibilityRole="button"
            onPress={props.onCollapse}
            style={[
                styles.container,
                createDesktopActivityOverlayChromeStyle(theme, {
                    visualMode: props.visualMode,
                    tone: 'expanded',
                }),
            ]}
        >
            <View
                pointerEvents="none"
                testID={surfaceTestID}
                style={StyleSheet.absoluteFill}
            >
                <DesktopActivityOverlayChromeBackdrop
                    theme={theme}
                    tone="expanded"
                    visualMode={props.visualMode}
                    width={props.model.window.expanded.width}
                    height={props.model.window.expanded.height}
                />
                <DesktopActivityOverlayChromeHighlights
                    theme={theme}
                    tone="expanded"
                    visualMode={props.visualMode}
                />
            </View>
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
            >
                <DesktopActivityOverlayExpandedCards
                    model={props.model}
                    visualMode={props.visualMode}
                    onOpenSession={props.onOpenSession}
                    onAction={props.onAction}
                />
            </ScrollView>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        paddingHorizontal: desktopActivityOverlayChromeMetrics.expanded.paddingHorizontal,
        paddingTop: desktopActivityOverlayChromeMetrics.expanded.paddingTop,
        paddingBottom: desktopActivityOverlayChromeMetrics.expanded.paddingBottom,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        gap: 6,
        paddingBottom: 0,
    },
});
