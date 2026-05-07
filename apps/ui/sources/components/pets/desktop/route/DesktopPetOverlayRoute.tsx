import * as React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { DEFAULT_BUILT_IN_PET_ID } from '@/components/pets/builtIns/builtInPetRegistry';
import { usePetCompanionActivityModel, type PetCompanionTrayItem } from '@/components/pets/activity';
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
    listenDesktopPetOverlayWindowState,
    releaseDesktopPetOverlayDragVelocity,
    showMainWindowFromDesktopPetOverlay,
    startDesktopPetOverlayDragSession,
    syncDesktopPetOverlayElementMetrics,
} from '../bridge/desktopPetOverlayBridge';
import {
    resolveDesktopPetOverlayGeometry,
} from '../desktopPetOverlayGeometry';

const CONTEXT_ACTION_SHOULDER_BOTTOM_OFFSET_PX = 12;
const CONTEXT_ACTION_SIZE_PX = 30;

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
    const [dismissedTrayItemKeys, setDismissedTrayItemKeys] = React.useState<ReadonlySet<string>>(() => new Set());
    const activity = usePetCompanionActivityModel({ dismissedTrayItemKeys });
    const [trayOpen, setTrayOpen] = React.useState(false);
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
    const handleDismissTrayItem = React.useCallback((item: PetCompanionTrayItem) => {
        setDismissedTrayItemKeys((current) => {
            const next = new Set(current);
            next.add(item.dismissKey);
            return next;
        });
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
    const hasTrayItems = petVisible && trayItemCount > 0;
    const trayVisible = hasTrayItems && trayOpen;
    const windowSize = React.useMemo(
        () => {
            if (nativeLayoutState) return nativeLayoutState.window;
            return hasTrayItems
                ? { width: geometry.expandedWindowWidth, height: geometry.expandedWindowHeight }
                : { width: geometry.windowWidth, height: geometry.windowHeight };
        },
        [
            geometry.expandedWindowHeight,
            geometry.expandedWindowWidth,
            geometry.windowHeight,
            geometry.windowWidth,
            hasTrayItems,
            nativeLayoutState,
        ],
    );
    const mascotStyle = nativeLayoutState
        ? rectStyle(nativeLayoutState.mascot)
        : [
            styles.state,
            {
                width: geometry.windowWidth,
                height: geometry.windowHeight,
            },
            hasTrayItems ? styles.stateExpanded : styles.stateCompact,
        ];
    const trayStyle = nativeLayoutState?.tray
        ? rectStyle(nativeLayoutState.tray)
        : [
            styles.tray,
            { bottom: geometry.windowHeight + 18 },
        ];
    const contextActionsStyle = nativeLayoutState
        ? rectStyle({
            ...nativeLayoutState.controls,
            width: nativeLayoutState.controls.width || CONTEXT_ACTION_SIZE_PX,
            height: nativeLayoutState.controls.height || CONTEXT_ACTION_SIZE_PX,
        })
        : hasTrayItems
            ? [styles.contextExpanded, { bottom: geometry.windowHeight - CONTEXT_ACTION_SHOULDER_BOTTOM_OFFSET_PX }]
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
                    onDismissItem={handleDismissTrayItem}
                    onQuickReply={actions.quickReply}
                    style={trayStyle}
                />
            ) : null}
            {petVisible ? (
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
        right: 36,
        bottom: 18,
    },
    tray: {
        position: 'absolute',
        right: 58,
    },
    contextCompact: {
        right: 14,
        top: 22,
    },
    contextExpanded: {
        right: 46,
    },
});
