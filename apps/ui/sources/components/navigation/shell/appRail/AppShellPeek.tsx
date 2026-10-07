import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveOverlayMotionPreset, useOverlayPanelMotion, useOverlayPresence } from '@/components/ui/overlays/motion/overlayMotion';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { useHoverPreviewPopover, type HoverPreviewHandlers } from '@/components/ui/popover/useHoverPreviewPopover';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import type { AppShellShownColumn } from './appRailModel';
import { appShellColumnSurface } from './appShellColumnSurface';

/** A peek is keyed by the destination whose column it shows (a built-in or a plugin page). */
type PeekKind = string;

type AppShellPeekValue = Readonly<{
    /** Whether resting on this destination's icon peeks its column (not the column already open). */
    peeks: (kind: PeekKind) => boolean;
    triggerProps: (kind: PeekKind) => HoverPreviewHandlers | null;
    openFocused: (kind: PeekKind) => void;
    peek: Readonly<{ kind: PeekKind; focus: boolean }> | null;
    panelProps: HoverPreviewHandlers | null;
    columnShown: boolean;
}>;

const AppShellPeekContext = React.createContext<AppShellPeekValue | null>(null);

export function useAppShellPeek(): AppShellPeekValue | null {
    return React.useContext(AppShellPeekContext);
}

/**
 * Peeking a destination's column from the rail (user refinement 2026-09-28): resting on a destination
 * icon shows that destination's column in the column's own place, at its width and full height — over
 * the open column, or floating over the page while the column is collapsed. The open destination's
 * own icon does not peek while its column is showing. The peek stays while the pointer is in it,
 * closes a moment after it leaves or on Escape, and the right arrow on the icon moves focus in.
 * Provided by `SidebarNavigator`, which owns the column.
 */
export function AppShellPeekProvider(props: Readonly<{
    enabled: boolean;
    /** The destination whose column stands beside the page, or `null` for a full page. */
    currentId: string | null;
    columnShown: boolean;
    children: React.ReactNode;
}>) {
    const { enabled, currentId, columnShown } = props;
    const hover = useHoverPreviewPopover<PeekKind>({ enabled });
    const focusReturnRef = React.useRef<HTMLElement | null>(null);
    const peeks = React.useCallback(
        (kind: PeekKind) => enabled && !(columnShown && kind === currentId),
        [columnShown, currentId, enabled],
    );
    const { close, open, triggerHoverProps, mode } = hover;
    React.useEffect(() => {
        if (mode === 'closed' || Platform.OS !== 'web' || typeof document === 'undefined') return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            close();
            focusReturnRef.current?.focus?.();
            focusReturnRef.current = null;
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [close, mode]);
    // Navigating closes a peek: the destination's own column (or none) stands there now.
    React.useEffect(() => close(), [close, currentId]);
    const value = React.useMemo<AppShellPeekValue>(() => ({
        peeks,
        triggerProps: (kind) => (peeks(kind) ? triggerHoverProps(kind) : null),
        openFocused: (kind) => {
            if (!peeks(kind)) return;
            if (typeof document !== 'undefined') focusReturnRef.current = document.activeElement as HTMLElement | null;
            open(kind);
        },
        peek: mode !== 'closed' && hover.target ? { kind: hover.target, focus: mode === 'open' } : null,
        panelProps: hover.panelHoverProps,
        columnShown,
    }), [columnShown, hover.panelHoverProps, hover.target, mode, open, peeks, triggerHoverProps]);
    return <AppShellPeekContext.Provider value={value}>{props.children}</AppShellPeekContext.Provider>;
}

/**
 * The peeked column, laid over the column's place in the content sheet: the same plane
 * (`appShellColumnSurface`), width and full height, rendered by the column's own component, lifted
 * above what it covers. It slides in from under the rail and back out, turning around in place when
 * the pointer changes its mind; moving to another icon swaps the column in the standing layer. While
 * it leaves it keeps showing the column it had, and no longer takes the pointer.
 */
export function AppShellPeekLayer(props: Readonly<{
    widthPx: number;
    /** The column a destination stands beside its page, from the one catalog. */
    resolveColumn: (destinationId: string) => AppShellShownColumn | null;
    renderColumn: (column: AppShellShownColumn) => React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const context = useAppShellPeek();
    const layerRef = React.useRef<View>(null);
    const peek = context?.peek ?? null;
    const focus = peek?.focus === true;
    const lastPeekRef = React.useRef(peek);
    if (peek) lastPeekRef.current = peek;
    const preset = React.useMemo(
        () => resolveOverlayMotionPreset({ kind: 'panel', direction: 'right', travelPx: props.widthPx }),
        [props.widthPx],
    );
    const motion = useOverlayPanelMotion({ visible: peek !== null, preset, elementRef: layerRef });
    const presence = useOverlayPresence(peek !== null, motion.exitMs);
    const shown = peek ?? (presence.present ? lastPeekRef.current : null);
    // The column renders in the background (`useDeferredValue`): the plane mounts and starts sliding at
    // once, and the column fills it when ready, so a heavy column never holds the slide. A swap keeps the
    // last column until the next one is ready.
    const columnKind = React.useDeferredValue(shown?.kind ?? null, null);
    const column = columnKind ? props.resolveColumn(columnKind) : null;
    // Focus moves in once the column it asked for has rendered.
    const focusReady = focus && columnKind === peek?.kind;
    React.useEffect(() => {
        if (!focusReady || Platform.OS !== 'web') return;
        const node = layerRef.current as unknown as HTMLElement | null;
        const target = node?.querySelector?.<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])');
        target?.focus();
    }, [focusReady, peek?.kind]);
    if (!context || !shown || !props.resolveColumn(shown.kind)) return null;
    const leaving = peek === null;
    const pointerEvents = resolveOverlayPointerEvents(leaving ? 'none' : 'auto');
    return (
        <Animated.View
            ref={layerRef}
            testID={`app-shell-peek:${shown.kind}`}
            pointerEvents={pointerEvents.nativePointerEvents}
            {...(leaving ? null : context.panelProps)}
            style={[
                appShellColumnSurface.peekEdge,
                appShellColumnSurface.peekLift,
                styles.layer,
                { width: props.widthPx },
                motion.style,
                pointerEvents.webStyle,
            ]}
        >
            {/* Native keeps the opaque column plane; web blurs the page under the peek when its group does. */}
            <GlassSurface surfaceGroup="sidebar" solidColor={theme.colors.surface.inset} enabled={Platform.OS === 'web'}
                style={styles.material}>
                <PluginSurfaceFocusEligibilityProvider active={focusReady}
                    presentationActive={peek !== null && columnKind === peek.kind} currentUiContextActive={false}>
                    {column ? props.renderColumn(column) : null}
                </PluginSurfaceFocusEligibilityProvider>
            </GlassSurface>
        </Animated.View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    material: {
        flex: 1,
        minHeight: 0,
    },
    layer: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        zIndex: 3,
        overflow: 'hidden',
    },
}));
