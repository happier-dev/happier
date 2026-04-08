import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useDesktopOverlayDragController } from '@/activity/adapters/desktop/positioning/useDesktopOverlayDragController';
import {
    emitDesktopActivityOverlayInteraction,
    setDesktopActivityOverlayExpanded,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { useDesktopActivityOverlayState } from '@/activity/adapters/desktop/runtime/useDesktopActivityOverlayState';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { DesktopActivityOverlayCollapsed } from './DesktopActivityOverlayCollapsed';
import { DesktopActivityOverlayExpanded } from './DesktopActivityOverlayExpanded';
import { DesktopActivityOverlayMotionFrame } from './DesktopActivityOverlayMotionFrame';
import { resolveDesktopActivityOverlayVisualMode } from './DesktopActivityOverlayVisualMode';

function emitInteraction(actionIdentifier: string, data: Record<string, unknown> = {}) {
    fireAndForget(
        emitDesktopActivityOverlayInteraction({
            actionIdentifier,
            data,
        }),
        { tag: `DesktopActivityOverlayRoute.emitInteraction.${actionIdentifier}` },
    );
}

function useDesktopOverlayTransparentDocumentBackground(enabled: boolean) {
    React.useLayoutEffect(() => {
        if (!enabled || typeof document === 'undefined') {
            return;
        }

        const canInjectStylesheet = typeof document.createElement === 'function';
        const styleElementId = 'desktop-activity-overlay-transparent-style';
        const existingStyleElement = canInjectStylesheet ? document.getElementById?.(styleElementId) : null;
        const styleElement = canInjectStylesheet
            ? (existingStyleElement && (existingStyleElement as unknown as { nodeName?: string }).nodeName === 'STYLE'
                ? (existingStyleElement as HTMLStyleElement)
                : document.createElement('style'))
            : null;
        const injectedStyleElement = canInjectStylesheet && !existingStyleElement;

        if (styleElement) {
            // Keep the stylesheet content up to date even across fast refresh or partial reloads where the
            // style element may persist between mounts.
            styleElement.id = styleElementId;
            styleElement.textContent = `
                html, body, #root, #app, #expo-root {
                    background: transparent !important;
                    background-color: transparent !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    overflow: hidden !important;
                    height: 100% !important;
                    width: 100% !important;
                }
                #root > div, #root > div > div, #root > div > div > div {
                    background: transparent !important;
                    background-color: transparent !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    height: 100% !important;
                    width: 100% !important;
                }
            `;
            if (injectedStyleElement) {
                document.head?.appendChild?.(styleElement);
            }
        }

        const htmlStyle = document.documentElement?.style;
        const bodyStyle = document.body?.style;
        const rootStyle = document.getElementById?.('root')?.style;
        if (!htmlStyle || !bodyStyle) {
            return;
        }

        const previousHtmlBackgroundColor = htmlStyle.backgroundColor;
        const previousHtmlBackground = htmlStyle.background;
        const previousBodyBackgroundColor = bodyStyle.backgroundColor;
        const previousBodyBackground = bodyStyle.background;
        const previousBodyMargin = bodyStyle.margin;
        const previousBodyPadding = bodyStyle.padding;
        const previousBodyOverflow = bodyStyle.overflow;
        const previousRootBackgroundColor = rootStyle?.backgroundColor;
        const previousRootBackground = rootStyle?.background;
        const previousRootMargin = rootStyle?.margin;
        const previousRootPadding = rootStyle?.padding;

        htmlStyle.backgroundColor = 'transparent';
        htmlStyle.background = 'transparent';
        bodyStyle.backgroundColor = 'transparent';
        bodyStyle.background = 'transparent';
        bodyStyle.margin = '0px';
        bodyStyle.padding = '0px';
        bodyStyle.overflow = 'hidden';
        if (rootStyle) {
            rootStyle.backgroundColor = 'transparent';
            rootStyle.background = 'transparent';
            rootStyle.margin = '0px';
            rootStyle.padding = '0px';
        }

        return () => {
            htmlStyle.backgroundColor = previousHtmlBackgroundColor;
            htmlStyle.background = previousHtmlBackground;
            bodyStyle.backgroundColor = previousBodyBackgroundColor;
            bodyStyle.background = previousBodyBackground;
            bodyStyle.margin = previousBodyMargin;
            bodyStyle.padding = previousBodyPadding;
            bodyStyle.overflow = previousBodyOverflow;
            if (rootStyle) {
                rootStyle.backgroundColor = previousRootBackgroundColor ?? '';
                rootStyle.background = previousRootBackground ?? '';
                rootStyle.margin = previousRootMargin ?? '';
                rootStyle.padding = previousRootPadding ?? '';
            }
            if (styleElement && injectedStyleElement) {
                styleElement.remove();
            }
        };
    }, [enabled]);
}

export function DesktopActivityOverlayRoute(): React.ReactElement {
    const state = useDesktopActivityOverlayState();
    const inOverlayWindowContext = isDesktopActivityOverlayWindowContext();
    useDesktopOverlayTransparentDocumentBackground(inOverlayWindowContext);

    const dragHandlers = useDesktopOverlayDragController({
        enabled: Boolean(
            state
            && !state.expanded
            && state.policy.enableDragReposition
            && !state.policy.lockPosition,
        ),
    });

    if (!inOverlayWindowContext) {
        return (
            <View testID="desktop-activity-overlay-hidden" style={styles.hiddenContainer} />
        );
    }

    if (!state) {
        return (
            <View testID="desktop-activity-overlay-loading" style={styles.loadingContainer}>
                <Text style={styles.loadingText}>{t('common.loading')}</Text>
            </View>
        );
    }

    if (!state.visible) {
        return (
            <View testID="desktop-activity-overlay-hidden" style={styles.hiddenContainer} />
        );
    }

    const collapsedIsInteractive = state.policy.interactiveCollapsed;
    const visualMode = resolveDesktopActivityOverlayVisualMode({
        presentationMode: state.policy.presentationMode,
        compactStyle: state.policy.compactStyle,
        hostMode: state.placementDiagnostics?.hostMode ?? null,
    });
    const expandsOnClick =
        state.policy.clickAction === 'expand_overlay'
        && state.policy.expandedBehavior === 'click';
    const expandsOnHover =
        state.policy.clickAction === 'expand_overlay'
        && state.policy.expandedBehavior === 'hover';

    const expandOverlay = () => {
        fireAndForget(setDesktopActivityOverlayExpanded(true), {
            tag: 'DesktopActivityOverlayRoute.expand',
        });
        emitInteraction('overlay-set-expanded', { expanded: true });
    };

    const onCollapsedPress = () => {
        if (!collapsedIsInteractive) {
            return;
        }

        switch (state.policy.clickAction) {
            case 'open_primary_session': {
                const primarySessionId = state.model.expanded.rows[0]?.sessionId ?? null;
                if (!primarySessionId) {
                    emitInteraction('open-inbox');
                    return;
                }
                emitInteraction(`open-session:${primarySessionId}`, {
                    primarySessionId,
                });
                return;
            }
            case 'open_sessions': {
                emitInteraction('open-inbox');
                return;
            }
            case 'expand_overlay':
            default: {
                if (!expandsOnClick) {
                    return;
                }
                expandOverlay();
            }
        }
    };

    if (state.expanded) {
        return (
            <View style={styles.container}>
                <DesktopActivityOverlayMotionFrame key="expanded" visible={state.visible} expanded>
                <DesktopActivityOverlayExpanded
                    model={state.model}
                    visualMode={visualMode}
                    onCollapse={() => {
                        fireAndForget(setDesktopActivityOverlayExpanded(false), {
                            tag: 'DesktopActivityOverlayRoute.collapse',
                        });
                            emitInteraction('overlay-set-expanded', { expanded: false });
                        }}
                        onOpenSession={(sessionId) => {
                            emitInteraction(`open-session:${sessionId}`, { sessionId });
                        }}
                        onOpenInbox={() => {
                            emitInteraction('open-inbox');
                        }}
                    />
                </DesktopActivityOverlayMotionFrame>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <DesktopActivityOverlayMotionFrame key="collapsed" visible={state.visible} expanded={false}>
                <DesktopActivityOverlayCollapsed
                    model={state.model}
                    visualMode={visualMode}
                    interactive={collapsedIsInteractive}
                    dragHandlers={dragHandlers}
                    onPress={onCollapsedPress}
                    onHoverIn={collapsedIsInteractive && expandsOnHover ? expandOverlay : undefined}
                />
            </DesktopActivityOverlayMotionFrame>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'flex-start',
        alignItems: 'stretch',
        backgroundColor: 'transparent',
    },
    hiddenContainer: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: 'transparent',
    },
    loadingText: {
        fontSize: 12,
        opacity: 0.8,
    },
});
