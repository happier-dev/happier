import * as React from 'react';
import { Animated, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion';
import { resolveOverlayMotionPreset, useOverlayPanelMotion, useOverlayPresence } from '@/components/ui/overlays/motion/overlayMotion';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { resolvePaneUnderlayAccessibilityProps } from '@/components/ui/panels/ModalPaneBoundary';
import {
    createHoverPreviewScope,
    HoverPreviewScopeProvider,
    useHoverPreviewPopover,
    type HoverPreviewHandlers,
    type HoverPreviewScope,
} from '@/components/ui/popover/useHoverPreviewPopover';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { AppShellMaterialPlane } from '../appShellMaterialPlane';
import type { AppShellShownColumn } from './appRailModel';
import { appShellColumnPlaneColor, appShellColumnSurface } from './appShellColumnSurface';

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
    /**
     * Whether the peeked column has rendered: it renders in the background, and the open column's
     * content gives way to it only then, so the column's place never stands empty.
     */
    peekReady: boolean;
    /** The rail's one hover intent: its peeks and its own popovers (`AppRailHoverScope`). */
    hoverScope: HoverPreviewScope;
}>;

const AppShellPeekContext = React.createContext<AppShellPeekValue | null>(null);

export function useAppShellPeek(): AppShellPeekValue | null {
    return React.useContext(AppShellPeekContext);
}

/** In the open column's place nothing travels: the peeked column and the open one cross-fade. */
const IN_PLACE_MOTION = resolveOverlayMotionPreset({ kind: 'panel', direction: 'center' });

/**
 * Peeking a destination's column from the rail (user refinement 2026-09-28): resting on a destination
 * icon shows that destination's column in the column's own place, at its width and full height — in
 * the open column's place, or floating over the page from the rail's edge while the column is
 * collapsed. The open destination's own icon does not peek while its column is showing. The peek stays
 * while the pointer is in it, closes a moment after it leaves or on Escape, and the right arrow on the
 * icon moves focus in. The rail is a dock: its peeks and its popovers answer one hover intent, a short
 * rest for the first and none for the next (`HoverPreviewScope`). Provided by `SidebarNavigator`,
 * which owns the column.
 */
export function AppShellPeekProvider(props: Readonly<{
    enabled: boolean;
    /** The destination whose column stands beside the page, or `null` for a full page. */
    currentId: string | null;
    columnShown: boolean;
    children: React.ReactNode;
}>) {
    const { enabled, currentId, columnShown } = props;
    const [hoverScope] = React.useState(() => createHoverPreviewScope(motionTokens.overlay.popover.dockHoverOpenDelayMs));
    React.useEffect(() => () => hoverScope.dispose(), [hoverScope]);
    const hover = useHoverPreviewPopover<PeekKind>({ enabled, scope: hoverScope });
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
    const peekKind = mode !== 'closed' ? hover.target : null;
    // Commits with the peeked column's own background render (`AppShellPeekLayer`'s deferred column).
    const readyKind = React.useDeferredValue(peekKind, null);
    // A swap keeps the last peeked column until the next has rendered, so it stays ready throughout.
    const peekReady = peekKind !== null && readyKind !== null;
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
        peekReady,
        hoverScope,
    }), [columnShown, hover.panelHoverProps, hover.target, hoverScope, mode, open, peekReady, peeks, triggerHoverProps]);
    return <AppShellPeekContext.Provider value={value}>{props.children}</AppShellPeekContext.Provider>;
}

/**
 * The rail's own hover previews (Inbox, Usage, Machines, Bots) answer in the same intent as its column
 * peeks: one shows at a time, and moving between rail icons opens the next at once. Only the rail's
 * subtree joins; hover previews on the page keep their own.
 */
export function AppRailHoverScope(props: Readonly<{ children: React.ReactNode }>) {
    const scope = useAppShellPeek()?.hoverScope ?? null;
    return <HoverPreviewScopeProvider scope={scope}>{props.children}</HoverPreviewScopeProvider>;
}

/**
 * The open column's own content. While a peek stands in its place it fades out under it, and back in
 * as the peek leaves, over the same time (`IN_PLACE_MOTION`), so the two cross-fade on the one plane.
 */
export function AppShellPeekCovered(props: Readonly<{ children: React.ReactNode }>) {
    const context = useAppShellPeek();
    const covered = context !== null && context.columnShown && context.peek !== null && context.peekReady;
    const contentRef = React.useRef<View>(null);
    const motion = useOverlayPanelMotion({ visible: !covered, preset: IN_PLACE_MOTION, elementRef: contentRef, appear: false });
    const underlayProps = resolvePaneUnderlayAccessibilityProps(covered, Platform.OS === 'web');
    const pointerEvents = resolveOverlayPointerEvents(underlayProps.pointerEvents);
    return (
        <Animated.View {...underlayProps} ref={contentRef} style={[stylesheet.covered, motion.style, pointerEvents.webStyle]}
            pointerEvents={pointerEvents.nativePointerEvents}>
            <PluginSurfaceFocusEligibilityProvider active={!covered}>
                {props.children}
            </PluginSurfaceFocusEligibilityProvider>
        </Animated.View>
    );
}

/**
 * The peeked column, rendered by the column's own component in the column's place. With the column
 * open it stands inside the column's plane (the frame places it there) and paints nothing of its own:
 * the open column's content fades out (`AppShellPeekCovered`) while the peeked one fades in, and no
 * edge or band appears. With the column collapsed it floats over the page at the column's width, in
 * the same plane material (`appShellColumnSurface`) lifted on its trailing edge, and slides out from
 * under the rail's edge, which clips it (the frame's peek host), and back. Either way it turns around
 * in place when the pointer changes its mind; moving to another icon swaps the column in the standing
 * layer. While it leaves it keeps showing the column it had, and no longer takes the pointer.
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
    const inPlace = context?.columnShown === true;
    const lastPeekRef = React.useRef(peek);
    if (peek) lastPeekRef.current = peek;
    const preset = React.useMemo(
        () => (inPlace ? IN_PLACE_MOTION : resolveOverlayMotionPreset({ kind: 'panel', direction: 'right', travelPx: props.widthPx })),
        [inPlace, props.widthPx],
    );
    // In the open column's place it fades in once its column has rendered, as the open one fades out.
    const motion = useOverlayPanelMotion({ visible: peek !== null && (!inPlace || context?.peekReady === true), preset, elementRef: layerRef });
    const presence = useOverlayPresence(peek !== null, motion.exitMs);
    const shown = peek ?? (presence.present ? lastPeekRef.current : null);
    // The column renders in the background (`useDeferredValue`): floating, the plane mounts and starts
    // moving at once and the column fills it when ready, so a heavy column never holds the slide; in the
    // open column's place the open content stays until it is ready (`peekReady`). A swap keeps the last
    // column until the next one is ready.
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
    // Not ready in the open column's place: still invisible there, so the open column keeps the pointer.
    const waiting = inPlace && !context.peekReady;
    const pointerEvents = resolveOverlayPointerEvents(leaving || waiting ? 'none' : 'auto');
    const content = (
        <PluginSurfaceFocusEligibilityProvider active={focusReady}
            presentationActive={peek !== null && columnKind === peek.kind} currentUiContextActive={false}>
            {column ? props.renderColumn(column) : null}
        </PluginSurfaceFocusEligibilityProvider>
    );
    return (
        <Animated.View
            ref={layerRef}
            testID={`app-shell-peek:${shown.kind}`}
            pointerEvents={pointerEvents.nativePointerEvents}
            {...(leaving ? null : context.panelProps)}
            style={[
                inPlace ? styles.inPlace : [appShellColumnSurface.peekLift, styles.floating, { width: props.widthPx }],
                motion.style,
                pointerEvents.webStyle,
            ]}
        >
            {inPlace ? content : (
                <AppShellMaterialPlane group="sidebar" color={appShellColumnPlaneColor(theme.colors)}
                    translucentColor={theme.colors.surface.selected} style={styles.material}>
                    {content}
                </AppShellMaterialPlane>
            )}
        </Animated.View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    material: {
        flex: 1,
        minHeight: 0,
    },
    covered: {
        flex: 1,
        minHeight: 0,
    },
    inPlace: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        zIndex: 1,
    },
    floating: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        zIndex: 3,
        overflow: 'hidden',
    },
}));
