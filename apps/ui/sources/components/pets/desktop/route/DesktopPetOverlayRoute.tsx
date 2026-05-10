import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { DEFAULT_BUILT_IN_PET_ID } from '@/components/pets/builtIns/builtInPetRegistry';
import {
    usePetCompanionActivityModel,
    usePetCompanionTrayDismissals,
} from '@/components/pets/activity';
import { DesktopPetOverlayContextActions } from '@/components/pets/desktop/actions/DesktopPetOverlayContextActions';
import { useDesktopPetOverlayActions } from '@/components/pets/desktop/actions/useDesktopPetOverlayActions';
import {
    type DesktopPetOverlayMeasurementElementResolver,
    type DesktopPetOverlayMeasuredLayout,
    type DesktopPetOverlayMeasuredRect,
    type DesktopPetOverlayNativeLayoutState,
    useDesktopPetOverlayMeasuredLayout,
} from '@/components/pets/desktop/layout/useDesktopPetOverlayMeasuredLayout';
import { DesktopPetOverlayTray } from '@/components/pets/desktop/tray/DesktopPetOverlayTray';
import { PET_VELOCITY_SAMPLE_WINDOW_MS } from '@/components/pets/interaction/petPointerDragConfig';
import {
    type PetPointerDragEnd,
    type PetPointerDragMove,
    type PetPointerDragRelease,
    type PetPointerDragStart,
    usePetPointerDragSession,
} from '@/components/pets/interaction/usePetPointerDragSession';
import { PetCompanionSurface } from '@/components/pets/render/PetCompanionSurface';
import { usePetSpritesheetSourceResult } from '@/components/pets/render/usePetSpritesheetSource';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import { useLocalSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { applyDesktopPetOverlayTransparentDocumentBackground } from './DesktopPetOverlayTransparentDocumentBackground';
import {
    applyDesktopPetOverlayDragDelta,
    endDesktopPetOverlayDragSession,
    listenDesktopPetOverlayNativeMouse,
    listenDesktopPetOverlayWindowState,
    releaseDesktopPetOverlayDragVelocity,
    showMainWindowFromDesktopPetOverlay,
    startDesktopPetOverlayDragSession,
    syncDesktopPetOverlayElementMetrics,
} from '../bridge/desktopPetOverlayBridge';
import {
    DESKTOP_PET_OVERLAY_CONTEXT_BOTTOM_GAP_PX,
    DESKTOP_PET_OVERLAY_CONTEXT_MASCOT_TOP_OVERLAP_PX,
    DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX,
    DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX,
    DESKTOP_PET_OVERLAY_TRAY_GAP_PX,
    resolveDesktopPetOverlayGeometry,
} from '../desktopPetOverlayGeometry';

const CONTEXT_ACTION_SIZE_PX = 30;
const PET_TRAY_SESSION_ID_ATTRIBUTE = 'data-pet-tray-session-id';

export type DesktopPetOverlayRouteProps = Readonly<{
    nativeLayoutState?: DesktopPetOverlayNativeLayoutState | null;
    measurementElementResolver?: DesktopPetOverlayMeasurementElementResolver;
    onMeasuredLayoutChange?: (layout: DesktopPetOverlayMeasuredLayout) => void;
}>;

function rectStyle(rect: DesktopPetOverlayMeasuredRect): ViewStyle {
    return {
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
    };
}

function trayRectStyle(
    rect: DesktopPetOverlayMeasuredRect,
    layout: DesktopPetOverlayNativeLayoutState,
): ViewStyle {
    const baseStyle: ViewStyle = {
        position: 'absolute',
        left: rect.x,
        width: rect.width,
    };
    if (layout.placement === 'bottomStart' || layout.placement === 'bottomEnd') {
        return {
            ...baseStyle,
            top: rect.y,
        };
    }
    return {
        ...baseStyle,
        bottom: layout.window.height - rect.y - rect.height,
    };
}

function normalizeNativeLayoutRect(rect: unknown): DesktopPetOverlayMeasuredRect | null {
    if (!rect || typeof rect !== 'object') return null;
    const record = rect as Record<string, unknown>;
    const x = typeof record.x === 'number' ? record.x : record.left;
    const y = typeof record.y === 'number' ? record.y : record.top;
    if (
        typeof x !== 'number'
        || typeof y !== 'number'
        || typeof record.width !== 'number'
        || typeof record.height !== 'number'
    ) {
        return null;
    }
    return {
        x,
        y,
        width: record.width,
        height: record.height,
    };
}

function normalizeNativeLayoutState(layout: unknown): DesktopPetOverlayNativeLayoutState | null {
    if (!layout || typeof layout !== 'object') return null;
    const record = layout as Record<string, unknown>;
    const windowRecord = record.window;
    if (!windowRecord || typeof windowRecord !== 'object') return null;
    const windowSize = windowRecord as Record<string, unknown>;
    const mascot = normalizeNativeLayoutRect(record.mascot);
    const controls = normalizeNativeLayoutRect(record.controls);
    if (
        typeof windowSize.width !== 'number'
        || typeof windowSize.height !== 'number'
        || !mascot
        || !controls
    ) {
        return null;
    }
    return {
        placement: typeof record.placement === 'string' ? record.placement : undefined,
        window: {
            width: windowSize.width,
            height: windowSize.height,
        },
        mascot,
        tray: record.tray === null ? null : normalizeNativeLayoutRect(record.tray),
        controls,
    };
}

function resolveNativeHoveredTraySessionId(point: Readonly<{ x: number; y: number }>): string | null {
    const documentRef = globalThis.document;
    if (!documentRef || typeof documentRef.elementFromPoint !== 'function') return null;
    const element = documentRef.elementFromPoint(point.x, point.y);
    const trayItem = element?.closest?.(`[${PET_TRAY_SESSION_ID_ATTRIBUTE}]`);
    const sessionId = trayItem?.getAttribute?.(PET_TRAY_SESSION_ID_ATTRIBUTE)?.trim();
    return sessionId || null;
}

export function DesktopPetOverlayRoute(props: DesktopPetOverlayRouteProps = {}): React.ReactElement {
    React.useLayoutEffect(() => applyDesktopPetOverlayTransparentDocumentBackground(), []);
    const [nativeLayoutState, setNativeLayoutState] = React.useState<DesktopPetOverlayNativeLayoutState | null>(
        () => props.nativeLayoutState ?? null,
    );
    React.useEffect(() => {
        if (props.nativeLayoutState !== undefined) {
            setNativeLayoutState(props.nativeLayoutState);
        }
    }, [props.nativeLayoutState]);
    React.useEffect(() => {
        if (props.nativeLayoutState !== undefined) return undefined;
        let active = true;
        let unsubscribe: (() => void) | null = null;
        void listenDesktopPetOverlayWindowState((payload) => {
            if (!active) return;
            setNativeLayoutState(normalizeNativeLayoutState((payload as { layout?: unknown }).layout));
        }).then((nextUnsubscribe) => {
            if (!active) {
                nextUnsubscribe();
                return;
            }
            unsubscribe = nextUnsubscribe;
        }).catch(() => undefined);

        return () => {
            active = false;
            unsubscribe?.();
        };
    }, [props.nativeLayoutState]);
    const selectedPetPackage = useSelectedPetPackage();
    const localSettings = useLocalSettings();
    const { dismissedTrayItemKeys, dismissTrayItem } = usePetCompanionTrayDismissals();
    const activity = usePetCompanionActivityModel({ dismissedTrayItemKeys });
    const [trayOpen, setTrayOpen] = React.useState(false);
    const [nativeHoveredSessionId, setNativeHoveredSessionId] = React.useState<string | null>(null);
    const trayItemCount = activity.trayItems.length;
    const actions = useDesktopPetOverlayActions();
    const petVisible = selectedPetPackage.enabled && selectedPetPackage.source !== null;
    const spritesheetSource = usePetSpritesheetSourceResult(
        selectedPetPackage.source,
        DEFAULT_BUILT_IN_PET_ID,
        { fallbackWhileLoading: false },
    ).source;
    // Rust validates drag commands against an active pointer, so preserve IPC order across async Tauri invokes.
    const dragCommandQueueRef = React.useRef<Promise<void>>(Promise.resolve());
    const enqueueDragCommand = React.useCallback((command: () => Promise<void>) => {
        const queuedCommand = dragCommandQueueRef.current
            .catch(() => undefined)
            .then(command);
        dragCommandQueueRef.current = queuedCommand.catch(() => undefined);
    }, []);
    const geometry = React.useMemo(
        () => resolveDesktopPetOverlayGeometry(localSettings.petsCompanionSizeScale),
        [localSettings.petsCompanionSizeScale],
    );
    const handleDragStart = React.useCallback((start: PetPointerDragStart) => {
        enqueueDragCommand(() => startDesktopPetOverlayDragSession({
            pointerId: start.pointerId,
            screenX: start.screenX,
            screenY: start.screenY,
            startedAtMs: start.startedAtMs,
        }));
    }, [enqueueDragCommand]);
    const handleDragMove = React.useCallback((move: PetPointerDragMove) => {
        if (move.coordinateSpace !== 'screen') return;
        enqueueDragCommand(() => applyDesktopPetOverlayDragDelta({
            pointerId: move.pointerId,
            dx: move.deltaX,
            dy: move.deltaY,
            coordinateSpace: 'screen',
        }));
    }, [enqueueDragCommand]);
    const handleDragEnd = React.useCallback((end: PetPointerDragEnd) => {
        enqueueDragCommand(() => endDesktopPetOverlayDragSession({
            pointerId: end.pointerId,
            cancelled: end.cancelled,
            screenX: end.screenX,
            screenY: end.screenY,
        }));
    }, [enqueueDragCommand]);
    const handleDragRelease = React.useCallback((release: PetPointerDragRelease) => {
        enqueueDragCommand(() => releaseDesktopPetOverlayDragVelocity({
            pointerId: release.pointerId,
            vx: release.velocityX,
            vy: release.velocityY,
            sampleWindowMs: PET_VELOCITY_SAMPLE_WINDOW_MS,
        }));
    }, [enqueueDragCommand]);
    const handleActivate = React.useCallback(() => {
        void showMainWindowFromDesktopPetOverlay({ reason: 'mascot-click' });
    }, []);
    const drag = usePetPointerDragSession({
        coordinateSpace: 'screen',
        onDragStart: handleDragStart,
        onDragMove: handleDragMove,
        onDragEnd: handleDragEnd,
        onDragRelease: handleDragRelease,
        onActivate: handleActivate,
    });
    React.useEffect(() => {
        setTrayOpen((current) => {
            if (trayItemCount === 0) return false;
            return current || trayItemCount > 0;
        });
    }, [trayItemCount]);
    React.useEffect(() => {
        let active = true;
        let unsubscribe: (() => void) | null = null;
        void listenDesktopPetOverlayNativeMouse((payload) => {
            if (!active) return;
            if (!payload.inside) {
                setNativeHoveredSessionId(null);
                return;
            }
            setNativeHoveredSessionId(resolveNativeHoveredTraySessionId(payload));
        }).then((nextUnsubscribe) => {
            if (!active) {
                nextUnsubscribe();
                return;
            }
            unsubscribe = nextUnsubscribe;
        }).catch(() => undefined);

        return () => {
            active = false;
            unsubscribe?.();
        };
    }, []);
    const invalidateNativeLayoutState = React.useCallback(() => {
        setNativeLayoutState(null);
    }, []);
    const hasTrayItems = petVisible && trayItemCount > 0;
    const trayVisible = hasTrayItems && trayOpen;
    const resolvedNativeLayoutState = nativeLayoutState && (!trayVisible || nativeLayoutState.tray)
        ? nativeLayoutState
        : null;
    const windowSize = React.useMemo(
        () => {
            if (resolvedNativeLayoutState) return resolvedNativeLayoutState.window;
            return hasTrayItems
                ? { width: geometry.expandedWindowWidth, height: geometry.expandedWindowHeight }
                : { width: geometry.spriteWidth, height: geometry.spriteHeight };
        },
        [
            geometry.expandedWindowHeight,
            geometry.expandedWindowWidth,
            geometry.spriteHeight,
            geometry.spriteWidth,
            hasTrayItems,
            resolvedNativeLayoutState,
        ],
    );
    const mascotStyle = resolvedNativeLayoutState
        ? rectStyle(resolvedNativeLayoutState.mascot)
        : [
            styles.state,
            {
                width: geometry.spriteWidth,
                height: geometry.spriteHeight,
            },
            hasTrayItems ? styles.stateExpanded : styles.stateCompact,
        ];
    const trayStyle = resolvedNativeLayoutState?.tray
        ? trayRectStyle(resolvedNativeLayoutState.tray, resolvedNativeLayoutState)
        : [
            styles.tray,
            {
                bottom:
                    geometry.spriteHeight
                    + DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX
                    + DESKTOP_PET_OVERLAY_TRAY_GAP_PX,
            },
        ];
    const contextActionsStyle = resolvedNativeLayoutState
        ? rectStyle({
            ...resolvedNativeLayoutState.controls,
            width: resolvedNativeLayoutState.controls.width || CONTEXT_ACTION_SIZE_PX,
            height: resolvedNativeLayoutState.controls.height || CONTEXT_ACTION_SIZE_PX,
        })
        : hasTrayItems
            ? [
                styles.contextExpanded,
                {
                    bottom:
                        geometry.spriteHeight
                        + DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX
                        + DESKTOP_PET_OVERLAY_CONTEXT_BOTTOM_GAP_PX
                        - DESKTOP_PET_OVERLAY_CONTEXT_MASCOT_TOP_OVERLAP_PX,
                },
            ]
            : styles.contextCompact;
    useDesktopPetOverlayMeasuredLayout({
        enabled: petVisible,
        trayVisible,
        hasTrayItems,
        geometry,
        windowSize,
        elementResolver: props.measurementElementResolver,
        onMeasuredLayoutChange: props.onMeasuredLayoutChange,
        onElementMetricsChange: (metrics) => {
            void syncDesktopPetOverlayElementMetrics(metrics);
        },
    });

    return (
        <View
            style={[
                styles.root,
                { width: windowSize.width, height: windowSize.height },
            ]}
            testID="desktop-pet-overlay-root"
        >
            {petVisible ? (
                <PetCompanionSurface
                    state={drag.dragState ?? activity.state}
                    stateStyle={mascotStyle}
                    hitboxTestID="desktop-pet-overlay-hitbox"
                    spriteTestID="desktop-pet-overlay-sprite"
                    spritesheetSource={spritesheetSource}
                    scale={geometry.scale}
                    dragTargetRef={drag.dragTargetRef}
                    pointerHandlers={drag.pointerHandlers}
                    accessibilityLabel={t('settingsPets.desktopOverlayTitle')}
                    onActivate={handleActivate}
                    shouldSuppressPress={drag.shouldSuppressPress}
                />
            ) : null}
            {hasTrayItems ? (
                <DesktopPetOverlayTray
                    items={activity.trayItems}
                    open={trayOpen}
                    onOpenItem={actions.openTrayItem}
                    onDismissItem={dismissTrayItem}
                    onQuickReply={actions.quickReply}
                    onInteractionLayoutChange={invalidateNativeLayoutState}
                    externalActiveSessionId={nativeHoveredSessionId}
                    style={trayStyle}
                />
            ) : null}
            {hasTrayItems ? (
                <DesktopPetOverlayContextActions
                    trayCount={trayItemCount}
                    trayOpen={trayOpen}
                    onTrayOpenChange={setTrayOpen}
                    onTuck={actions.tuck}
                    style={contextActionsStyle}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    root: {
        backgroundColor: 'transparent',
        position: 'relative',
        overflow: 'hidden',
    },
    state: {
        position: 'absolute',
        alignItems: 'center',
        justifyContent: 'center',
    },
    stateCompact: {
        right: 0,
        bottom: 0,
    },
    stateExpanded: {
        right: DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX,
        bottom: DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_BOTTOM_INSET_PX,
    },
    tray: {
        position: 'absolute',
        right: DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX,
    },
    contextCompact: {
        right: 14,
        top: 22,
    },
    contextExpanded: {
        right: DESKTOP_PET_OVERLAY_EXPANDED_MASCOT_RIGHT_INSET_PX,
    },
});
