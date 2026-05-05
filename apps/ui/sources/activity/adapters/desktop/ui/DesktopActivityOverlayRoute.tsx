import * as React from 'react';
import { View, type ViewProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useDesktopOverlayDragController } from '@/activity/adapters/desktop/positioning/useDesktopOverlayDragController';
import { createActivitySurfaceSessionTarget } from '@/activity/actions/activitySurfaceTargets';
import {
    DESKTOP_ACTIVITY_OVERLAY_DEFAULT_HOVER_EXPAND_DELAY_MS,
    DESKTOP_ACTIVITY_OVERLAY_EXPANDED_HOVER_LEAVE_COLLAPSE_DELAY_MS,
    DESKTOP_ACTIVITY_OVERLAY_INPUT_LOCK_HEARTBEAT_MS,
} from '@/activity/adapters/desktop/desktopActivityOverlayTiming';
import {
    emitDesktopActivityOverlayInteraction,
    executeDesktopActivityOverlayInteractionWithResult,
    applyDesktopActivityOverlayDragDelta,
    releaseDesktopActivityOverlayDragVelocity,
    setDesktopActivityOverlayExpanded,
    setDesktopActivityOverlayInputLocked,
    showDesktopMainWindow,
} from '@/activity/adapters/desktop/runtime/desktopActivityOverlayBridge';
import { isDesktopActivityOverlayWindowContext } from '@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext';
import { useDesktopActivityOverlayState } from '@/activity/adapters/desktop/runtime/useDesktopActivityOverlayState';
import { PET_VELOCITY_SAMPLE_WINDOW_MS } from '@/components/pets/interaction/petPointerDragConfig';
import {
    type PetPointerDragMove,
    usePetPointerDragSession,
} from '@/components/pets/interaction/usePetPointerDragSession';
import { PetCompanionSurface } from '@/components/pets/render/PetCompanionSurface';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { Text } from '@/components/ui/text/Text';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { normalizePetCompanionSizeScale } from '@/sync/domains/pets/companionSizeScale';
import { useLocalSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { DesktopActivityOverlayCollapsed } from './DesktopActivityOverlayCollapsed';
import { DesktopActivityOverlayExpanded } from './DesktopActivityOverlayExpanded';
import { DesktopActivityOverlayMotionFrame } from './DesktopActivityOverlayMotionFrame';
import { resolveDesktopActivityOverlayVisualMode } from './DesktopActivityOverlayVisualMode';
import type { DesktopActivityOverlayUiModel } from './shared/desktopActivityOverlayUiModel';
import { useDesktopOverlayTransparentDocumentBackground } from './useDesktopOverlayTransparentDocumentBackground';

type DesktopActivityOverlayExpandedReason =
    | 'click'
    | 'hover'
    | 'outside_hover'
    | 'keyboard_escape';

type DesktopActivityOverlayCompanionDataProps = ViewProps & Readonly<{
    dataSet: Readonly<{ petState: NonNullable<DesktopActivityOverlayUiModel['companion']>['state'] }>;
    'data-pet-state': NonNullable<DesktopActivityOverlayUiModel['companion']>['state'];
}>;

const DESKTOP_ACTIVITY_OVERLAY_COMPANION_BASE_WIDTH = 62;
const DESKTOP_ACTIVITY_OVERLAY_COMPANION_BASE_HEIGHT = 67;
const DESKTOP_ACTIVITY_OVERLAY_COMPANION_BASE_SCALE = 0.32;

function resolveDesktopActivityOverlayCompanionMetrics(sizeScale: unknown): Readonly<{
    width: number;
    height: number;
    scale: number;
}> {
    const resolvedSizeScale = normalizePetCompanionSizeScale(sizeScale);
    return {
        width: DESKTOP_ACTIVITY_OVERLAY_COMPANION_BASE_WIDTH * resolvedSizeScale,
        height: DESKTOP_ACTIVITY_OVERLAY_COMPANION_BASE_HEIGHT * resolvedSizeScale,
        scale: DESKTOP_ACTIVITY_OVERLAY_COMPANION_BASE_SCALE * resolvedSizeScale,
    };
}

function emitInteraction(actionIdentifier: string, data: Record<string, unknown> = {}) {
    fireAndForget(
        emitDesktopActivityOverlayInteraction({
            actionIdentifier,
            data,
        }),
        { tag: `DesktopActivityOverlayRoute.emitInteraction.${actionIdentifier}` },
    );
}

function withOptionalServerId(
    data: Record<string, unknown>,
    serverId: string | null | undefined,
): Record<string, unknown> {
    return serverId ? { ...data, serverId } : data;
}

function hasBlockingExpandedActionCard(model: DesktopActivityOverlayUiModel): boolean {
    return (model.expanded.cards ?? []).some((card) => (
        card.kind === 'permission_request' || card.kind === 'user_question'
    ));
}

function readPhysicalNotchWidth(
    state: ReturnType<typeof useDesktopActivityOverlayState>,
): number | null {
    const width = state?.placementDiagnostics?.displayContext?.physicalNotchSize?.width;
    return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null;
}

function DesktopActivityOverlayCompanion(props: Readonly<{
    model: DesktopActivityOverlayUiModel;
    dragState?: NonNullable<DesktopActivityOverlayUiModel['companion']>['state'] | null;
    dragTargetRef?: ReturnType<typeof usePetPointerDragSession>['dragTargetRef'];
    pointerHandlers?: ReturnType<typeof usePetPointerDragSession>['pointerHandlers'];
    onActivate?: () => void | Promise<void>;
    shouldSuppressPress?: () => boolean;
}>): React.ReactElement | null {
    const companion = props.model.companion;
    const reducedMotion = useReducedMotionPreference();
    const localSettings = useLocalSettings();
    const metrics = React.useMemo(
        () => resolveDesktopActivityOverlayCompanionMetrics(localSettings.petsCompanionSizeScale),
        [localSettings.petsCompanionSizeScale],
    );
    const spritesheetSource = usePetSpritesheetSource(
        companion?.pet.source,
        'blink',
    );
    if (!companion?.enabled) {
        return null;
    }

    const effectiveState = props.dragState ?? companion.state;
    const dataProps: DesktopActivityOverlayCompanionDataProps = {
        testID: 'desktop-activity-overlay-companion',
        dataSet: { petState: effectiveState },
        'data-pet-state': effectiveState,
        style: [
            styles.companion,
            {
                width: metrics.width,
                height: metrics.height,
            },
        ],
    };

    return (
        <View pointerEvents="box-none" style={styles.companionLayer}>
            <View {...dataProps}>
                <PetCompanionSurface
                    state={effectiveState}
                    stateStyle={[
                        styles.companionState,
                        {
                            width: metrics.width,
                            height: metrics.height,
                        },
                    ]}
                    hitboxTestID="desktop-activity-overlay-companion-hitbox"
                    spriteTestID="desktop-activity-overlay-companion-sprite"
                    spritesheetSource={spritesheetSource}
                    scale={metrics.scale}
                    reducedMotion={reducedMotion}
                    dragTargetRef={props.dragTargetRef}
                    pointerHandlers={props.pointerHandlers}
                    onActivate={props.onActivate}
                    shouldSuppressPress={props.shouldSuppressPress}
                />
            </View>
        </View>
    );
}

export function DesktopActivityOverlayRoute(): React.ReactElement {
    const state = useDesktopActivityOverlayState();
    const inOverlayWindowContext = isDesktopActivityOverlayWindowContext();
    const [quickReplyDraft, setQuickReplyDraft] = React.useState('');
    const [quickReplyInputLocked, setQuickReplyInputLocked] = React.useState(false);
    const quickReplyInputLockedRef = React.useRef(false);
    const hoverExpandTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverLeaveCollapseTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    useDesktopOverlayTransparentDocumentBackground(inOverlayWindowContext);
    const clearHoverExpandTimeout = React.useCallback(() => {
        if (hoverExpandTimeoutRef.current !== null) {
            clearTimeout(hoverExpandTimeoutRef.current);
            hoverExpandTimeoutRef.current = null;
        }
    }, []);
    const clearHoverLeaveCollapseTimeout = React.useCallback(() => {
        if (hoverLeaveCollapseTimeoutRef.current !== null) {
            clearTimeout(hoverLeaveCollapseTimeoutRef.current);
            hoverLeaveCollapseTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => clearHoverExpandTimeout, [clearHoverExpandTimeout]);
    React.useEffect(() => clearHoverLeaveCollapseTimeout, [clearHoverLeaveCollapseTimeout]);

    React.useEffect(() => {
        if (!state?.visible || state.expanded) {
            clearHoverExpandTimeout();
        }
    }, [clearHoverExpandTimeout, state?.expanded, state?.visible]);

    React.useEffect(() => {
        if (!state?.visible || !state.expanded) {
            clearHoverLeaveCollapseTimeout();
        }
    }, [clearHoverLeaveCollapseTimeout, state?.expanded, state?.visible]);

    const setOverlayInputLocked = React.useCallback((locked: boolean) => {
        if (quickReplyInputLockedRef.current === locked) {
            return;
        }
        quickReplyInputLockedRef.current = locked;
        setQuickReplyInputLocked(locked);
        fireAndForget(setDesktopActivityOverlayInputLocked(locked), {
            tag: locked
                ? 'DesktopActivityOverlayRoute.inputLock.lock'
                : 'DesktopActivityOverlayRoute.inputLock.unlock',
        });
        emitInteraction('overlay-input-locked', { locked });
    }, []);

    React.useEffect(() => {
        if (!state?.visible || !state.expanded || (!state.model.expanded.quickReply && quickReplyDraft.length === 0)) {
            setOverlayInputLocked(false);
        }
    }, [quickReplyDraft.length, setOverlayInputLocked, state?.expanded, state?.model.expanded.quickReply, state?.visible]);

    React.useEffect(() => {
        if (!quickReplyInputLocked) {
            return;
        }

        const interval = setInterval(() => {
            fireAndForget(setDesktopActivityOverlayInputLocked(true), {
                tag: 'DesktopActivityOverlayRoute.inputLock.heartbeat',
            });
        }, DESKTOP_ACTIVITY_OVERLAY_INPUT_LOCK_HEARTBEAT_MS);

        return () => clearInterval(interval);
    }, [quickReplyInputLocked]);

    const dragHandlers = useDesktopOverlayDragController({
        enabled: Boolean(
            state
            && !state.expanded
            && state.policy.enableDragReposition
            && !state.policy.lockPosition,
        ),
    });
    const companionDragEnabled = Boolean(
        state
        && state.policy.enableDragReposition
        && !state.policy.lockPosition,
    );
    const handleCompanionDragMove = React.useCallback((move: PetPointerDragMove) => {
        if (move.coordinateSpace !== 'screen') return;
        if (!companionDragEnabled) return;
        fireAndForget(applyDesktopActivityOverlayDragDelta(move.deltaX, move.deltaY), {
            tag: 'DesktopActivityOverlayRoute.companionDrag.applyDragDelta',
        });
    }, [companionDragEnabled]);
    const companionDrag = usePetPointerDragSession({
        coordinateSpace: 'screen',
        onDragMove: handleCompanionDragMove,
        onDragRelease: (release) => {
            if (!companionDragEnabled) return;
            fireAndForget(releaseDesktopActivityOverlayDragVelocity({
                pointerId: release.pointerId,
                vx: release.velocityX,
                vy: release.velocityY,
                sampleWindowMs: PET_VELOCITY_SAMPLE_WINDOW_MS,
            }), {
                tag: 'DesktopActivityOverlayRoute.companionDrag.releaseDragVelocity',
            });
        },
        onActivate: () => {
            fireAndForget(showDesktopMainWindow(), {
                tag: 'DesktopActivityOverlayRoute.companionDrag.activateMainWindow',
            });
        },
    });
    const companionPointerHandlers = companionDragEnabled ? companionDrag.pointerHandlers : undefined;
    const companionDragTargetRef = companionDragEnabled ? companionDrag.dragTargetRef : undefined;
    const shouldSuppressCompanionPress = companionDragEnabled ? companionDrag.shouldSuppressPress : undefined;

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

    const visualMode = resolveDesktopActivityOverlayVisualMode({
        presentationMode: state.policy.presentationMode,
        hostMode: state.placementDiagnostics?.hostMode ?? null,
    });
    const physicalNotchWidth = readPhysicalNotchWidth(state);

    const setOverlayExpanded = (expanded: boolean, reason: DesktopActivityOverlayExpandedReason) => {
        clearHoverExpandTimeout();
        clearHoverLeaveCollapseTimeout();
        fireAndForget(setDesktopActivityOverlayExpanded(expanded), {
            tag: expanded ? 'DesktopActivityOverlayRoute.expand' : 'DesktopActivityOverlayRoute.collapse',
        });
        emitInteraction('overlay-set-expanded', { expanded, reason });
    };

    const hoverExpandEnabled = visualMode !== 'notch_integrated' && state.policy.expandedBehavior === 'hover';

    const onCollapsedPress = () => {
        setOverlayExpanded(true, 'click');
    };

    const onCollapsedHoverIn = hoverExpandEnabled
        ? () => {
            clearHoverExpandTimeout();
            hoverExpandTimeoutRef.current = setTimeout(() => {
                hoverExpandTimeoutRef.current = null;
                setOverlayExpanded(true, 'hover');
            }, state.policy.hoverExpandDelayMs ?? DESKTOP_ACTIVITY_OVERLAY_DEFAULT_HOVER_EXPAND_DELAY_MS);
        }
        : undefined;
    const onCollapsedHoverOut = hoverExpandEnabled ? clearHoverExpandTimeout : undefined;

    const onExpandedHoverIn = () => {
        clearHoverLeaveCollapseTimeout();
        emitInteraction('overlay-surface-engaged', { engaged: true });
    };

    const onExpandedHoverOut = () => {
        emitInteraction('overlay-surface-engaged', { engaged: false });
        if (hasBlockingExpandedActionCard(state.model) || quickReplyInputLockedRef.current || quickReplyInputLocked) {
            return;
        }
        clearHoverLeaveCollapseTimeout();
        hoverLeaveCollapseTimeoutRef.current = setTimeout(() => {
            hoverLeaveCollapseTimeoutRef.current = null;
            setOverlayExpanded(false, 'outside_hover');
        }, DESKTOP_ACTIVITY_OVERLAY_EXPANDED_HOVER_LEAVE_COLLAPSE_DELAY_MS);
    };

    if (state.expanded) {
        return (
            <View style={styles.container}>
                <Text testID="desktop-activity-overlay-diagnostics" style={styles.diagnosticsText}>
                    {JSON.stringify(state.placementDiagnostics ?? null)}
                </Text>
                <DesktopActivityOverlayMotionFrame
                    visible={state.visible}
                    expanded
                    edgeAnchored={visualMode === 'notch_integrated'}
                >
                    <DesktopActivityOverlayExpanded
                        model={state.model}
                        visualMode={visualMode}
                        onHoverIn={onExpandedHoverIn}
                        onHoverOut={onExpandedHoverOut}
                        onOpenSession={(sessionId, serverId) => {
                            emitInteraction(
                                createActivitySurfaceSessionTarget(sessionId, serverId),
                                withOptionalServerId({ sessionId }, serverId),
                            );
                        }}
                        onAction={(action) => {
                            emitInteraction(action.actionIdentifier, { ...(action.data ?? {}) });
                        }}
                        quickReplyDraft={quickReplyDraft}
                        onQuickReplyDraftChange={setQuickReplyDraft}
                        onQuickReplySend={async ({ sessionId, serverId, message }) => {
                            try {
                                const result = await executeDesktopActivityOverlayInteractionWithResult({
                                    actionIdentifier: 'session.message.send',
                                    data: withOptionalServerId({ sessionId, message }, serverId),
                                });
                                return result.ok;
                            } catch {
                                return false;
                            }
                        }}
                        onQuickReplyInputLockChange={setOverlayInputLocked}
                        onQuickReplyCleanEscape={() => {
                            setOverlayExpanded(false, 'keyboard_escape');
                        }}
                    />
                    <DesktopActivityOverlayCompanion
                        model={state.model}
                        dragState={companionDrag.dragState}
                        dragTargetRef={companionDragTargetRef}
                        pointerHandlers={companionPointerHandlers}
                        onActivate={() => {
                            fireAndForget(showDesktopMainWindow(), {
                                tag: 'DesktopActivityOverlayRoute.companion.activateMainWindow',
                            });
                        }}
                        shouldSuppressPress={shouldSuppressCompanionPress}
                    />
                </DesktopActivityOverlayMotionFrame>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <Text testID="desktop-activity-overlay-diagnostics" style={styles.diagnosticsText}>
                {JSON.stringify(state.placementDiagnostics ?? null)}
            </Text>
            <DesktopActivityOverlayMotionFrame
                visible={state.visible}
                expanded={false}
                edgeAnchored={visualMode === 'notch_integrated'}
            >
                <DesktopActivityOverlayCollapsed
                    model={state.model}
                    visualMode={visualMode}
                    physicalNotchWidth={physicalNotchWidth}
                    dragHandlers={dragHandlers}
                    onPress={onCollapsedPress}
                    onHoverIn={onCollapsedHoverIn}
                    onHoverOut={onCollapsedHoverOut}
                />
                <DesktopActivityOverlayCompanion
                    model={state.model}
                    dragState={companionDrag.dragState}
                    dragTargetRef={companionDragTargetRef}
                    pointerHandlers={companionPointerHandlers}
                    onActivate={() => {
                        fireAndForget(showDesktopMainWindow(), {
                            tag: 'DesktopActivityOverlayRoute.companion.activateMainWindow',
                        });
                    }}
                    shouldSuppressPress={shouldSuppressCompanionPress}
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
    diagnosticsText: {
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: 0,
        pointerEvents: 'none',
        fontSize: 1,
    },
    companionLayer: {
        position: 'absolute',
        right: 8,
        bottom: 2,
        backgroundColor: 'transparent',
    },
    companion: {
        width: 62,
        height: 67,
        backgroundColor: 'transparent',
    },
    companionState: {
        width: 62,
        height: 67,
        backgroundColor: 'transparent',
    },
});
