import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveVerticalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';

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
import { useDesktopActivityOverlayMotionProgress } from './DesktopActivityOverlayMotionFrame';
import { DesktopActivityOverlayExpandedCards } from './cards/DesktopActivityOverlayExpandedCards';
import type {
    DesktopActivityOverlayActionDescriptor,
    DesktopActivityOverlayUiModel,
} from './shared/desktopActivityOverlayUiModel';
import { DesktopActivityOverlayQuickReplyComposer } from './quickReply/DesktopActivityOverlayQuickReplyComposer';

export function DesktopActivityOverlayExpanded(props: Readonly<{
    model: DesktopActivityOverlayUiModel;
    visualMode: DesktopActivityOverlayVisualMode;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    onOpenSession: (sessionId: string, serverId?: string | null) => void;
    onAction?: (action: DesktopActivityOverlayActionDescriptor) => void;
    quickReplyDraft?: string;
    onQuickReplyDraftChange?: (draft: string) => void;
    onQuickReplySend?: (params: { sessionId: string; serverId?: string | null; message: string }) => boolean | Promise<boolean>;
    onQuickReplyInputLockChange?: (locked: boolean) => void;
    onQuickReplyCleanEscape?: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const openProgress = useDesktopActivityOverlayMotionProgress();
    const surfaceTestID = resolveDesktopActivityOverlaySurfaceTestID('desktop-activity-overlay-expanded', props.visualMode);
    const quickReply = props.model.expanded.quickReply;
    const quickReplyDraft = props.quickReplyDraft ?? '';
    const shouldRenderQuickReply = Boolean(quickReply || quickReplyDraft.length > 0);
    const quickReplyServerId = typeof quickReply?.serverId === 'string' ? quickReply.serverId.trim() : '';
    const quickReplyTargetAvailable = Boolean(quickReply && quickReplyServerId.length > 0);
    const [completionAutoDismissPaused, setCompletionAutoDismissPaused] = React.useState(false);
    const scrollFades = useScrollEdgeFades({
        enabledEdges: { top: true, bottom: true },
        overflowThreshold: 2,
        edgeThreshold: 2,
    });
    const scrollMaskStyle = React.useMemo(
        () => resolveVerticalScrollEdgeMaskStyle(scrollFades.visibility, { fadeSize: 14 }),
        [scrollFades.visibility],
    );
    const handleHoverIn = React.useCallback(() => {
        setCompletionAutoDismissPaused(true);
        props.onHoverIn?.();
    }, [props.onHoverIn]);
    const handleHoverOut = React.useCallback(() => {
        setCompletionAutoDismissPaused(false);
        props.onHoverOut?.();
    }, [props.onHoverOut]);

    return (
        <Pressable
            testID="desktop-activity-overlay-expanded"
            onHoverIn={handleHoverIn}
            onHoverOut={handleHoverOut}
            onPress={() => {}}
            style={[
                styles.container,
                props.visualMode === 'notch_integrated'
                    ? styles.containerNotchIntegrated
                    : styles.containerFloating,
                createDesktopActivityOverlayChromeStyle(theme, {
                    visualMode: props.visualMode,
                    tone: 'expanded',
                    openProgress,
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
                    openProgress={openProgress}
                />
                <DesktopActivityOverlayChromeHighlights
                    theme={theme}
                    tone="expanded"
                    visualMode={props.visualMode}
                />
            </View>
            <ScrollView
                testID="desktop-activity-overlay-expanded-scroll"
                style={[styles.scroll, scrollMaskStyle]}
                contentContainerStyle={styles.scrollContent}
                showsVerticalScrollIndicator={false}
                scrollEventThrottle={16}
                onLayout={scrollFades.onViewportLayout}
                onContentSizeChange={scrollFades.onContentSizeChange}
                onScroll={scrollFades.onScroll}
                onMomentumScrollEnd={scrollFades.onMomentumScrollEnd}
            >
                <DesktopActivityOverlayExpandedCards
                    model={props.model}
                    visualMode={props.visualMode}
                    onOpenSession={props.onOpenSession}
                    onAction={props.onAction}
                    completionAutoDismissPaused={completionAutoDismissPaused}
                />
                {shouldRenderQuickReply ? (
                    <DesktopActivityOverlayQuickReplyComposer
                        visualMode={props.visualMode}
                        phrases={quickReply?.phrases ?? []}
                        draft={quickReplyDraft}
                        targetAvailable={quickReplyTargetAvailable}
                        onDraftChange={props.onQuickReplyDraftChange}
                        onSend={(message) => {
                            if (!quickReply || quickReplyServerId.length === 0) {
                                return false;
                            }
                            return props.onQuickReplySend?.({
                                sessionId: quickReply.targetSessionId,
                                serverId: quickReplyServerId,
                                message,
                            }) ?? false;
                        }}
                        onInputLockChange={props.onQuickReplyInputLockChange}
                        onCleanEscape={props.onQuickReplyCleanEscape}
                    />
                ) : null}
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
    },
    containerFloating: {
        paddingHorizontal: desktopActivityOverlayChromeMetrics.expanded.paddingHorizontal,
        paddingTop: desktopActivityOverlayChromeMetrics.expanded.paddingTop,
        paddingBottom: desktopActivityOverlayChromeMetrics.expanded.paddingBottom,
    },
    containerNotchIntegrated: {
        paddingHorizontal: desktopActivityOverlayChromeMetrics.expanded.notchPaddingHorizontal,
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
