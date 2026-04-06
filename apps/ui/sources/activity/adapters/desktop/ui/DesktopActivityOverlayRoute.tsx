import * as React from 'react';
import { StyleSheet, View } from 'react-native';

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

function emitInteraction(actionIdentifier: string, data: Record<string, unknown> = {}) {
    fireAndForget(
        emitDesktopActivityOverlayInteraction({
            actionIdentifier,
            data,
        }),
        { tag: `DesktopActivityOverlayRoute.emitInteraction.${actionIdentifier}` },
    );
}

export function DesktopActivityOverlayRoute(): React.ReactElement {
    const state = useDesktopActivityOverlayState();
    const inOverlayWindowContext = isDesktopActivityOverlayWindowContext();

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
                    compactStyle={state.policy.compactStyle}
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
        justifyContent: 'center',
        alignItems: 'center',
        padding: 8,
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
