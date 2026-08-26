import * as React from 'react';
import { Keyboard, Platform, View, type StyleProp, type ViewProps, type ViewStyle, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { usePopoverBoundaryRef } from './PopoverBoundary';
import { usePopoverScrollSourceRef } from './PopoverScrollSource';
import { requireRadixDismissableLayer } from '@/utils/web/radixCjs';
import { useOverlayPortal } from './OverlayPortal';
import { ModalPortalTargetProvider, useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { usePopoverPortalTarget } from './PopoverPortalTarget';
import {
    OverlayMotionFrame,
    resolveOverlayMotionDirectionFromPlacement,
    resolveOverlayMotionPreset,
    useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLocalSetting } from '@/sync/domains/state/storage';
import type {
    PopoverAnchor,
    PopoverBackdropEffect,
    PopoverBackdropOptions,
    PopoverOutsidePointerEventsMode,
    PopoverPlacement,
    PopoverPortalOptions,
    PopoverRenderProps,
    PopoverWindowRect,
    ResolvedPopoverPlacement,
} from './_types';
import { getFallbackBoundaryRect, measureInWindow, measureLayoutRelativeTo } from './measure';
import { resolvePortalRelativeAnchorRect } from './resolvePortalRelativeAnchor';
import { resolvePlacement } from './positioning';
import { PopoverBackdrop } from './backdrop';
import { POPOVER_PORTAL_Z_INDEX, tryRenderWebPortal, useNativeOverlayPortalNode } from './portal';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

const ViewWithWheel = View as unknown as React.ComponentType<ViewProps & { onWheel?: any }>;

export type {
    PopoverAnchor,
    PopoverBackdropEffect,
    PopoverBackdropOptions,
    PopoverOutsidePointerEventsMode,
    PopoverPlacement,
    PopoverPortalOptions,
    PopoverRenderProps,
    PopoverWindowRect,
    ResolvedPopoverPlacement,
} from './_types';

type WindowRect = PopoverWindowRect;

const RECT_UPDATE_TOLERANCE = 1;
const NATIVE_PORTAL_SHADOW_OUTSET = 16;

function readNumericStyleValue(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolvePaddingEdges(style: StyleProp<ViewStyle>): Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
}> {
    const flatStyle = StyleSheet.flatten(style) as ViewStyle | undefined;
    const base = readNumericStyleValue(flatStyle?.padding) ?? 0;
    const horizontal = readNumericStyleValue(flatStyle?.paddingHorizontal) ?? base;
    const vertical = readNumericStyleValue(flatStyle?.paddingVertical) ?? base;

    return {
        top: readNumericStyleValue(flatStyle?.paddingTop) ?? vertical,
        right: readNumericStyleValue(flatStyle?.paddingRight) ?? horizontal,
        bottom: readNumericStyleValue(flatStyle?.paddingBottom) ?? vertical,
        left: readNumericStyleValue(flatStyle?.paddingLeft) ?? horizontal,
    };
}

function addPaddingOutset(style: StyleProp<ViewStyle>, outset: number): ViewStyle {
    if (outset <= 0) return {};
    const edges = resolvePaddingEdges(style);
    return {
        paddingTop: edges.top + outset,
        paddingRight: edges.right + outset,
        paddingBottom: edges.bottom + outset,
        paddingLeft: edges.left + outset,
    };
}

function createWebPopoverModalPortalTarget(): HTMLElement | null {
    if (Platform.OS !== 'web') return null;
    if (typeof document === 'undefined') return null;
    if (typeof document.createElement !== 'function') return null;

    const target = document.createElement('div');
    target.setAttribute('data-happy-popover-modal-portal-target', '');
    Object.assign(target.style, {
        position: 'absolute',
        top: '0px',
        left: '0px',
        width: '0px',
        height: '0px',
        overflow: 'visible',
    } satisfies Partial<CSSStyleDeclaration>);
    return target;
}

function arePopoverRenderPropsEqual(a: PopoverRenderProps, b: PopoverRenderProps): boolean {
    return a.placement === b.placement && a.maxHeight === b.maxHeight && a.maxWidth === b.maxWidth;
}

function areWindowRectsEqual(a: WindowRect | null, b: WindowRect | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;

    return (
        Math.abs(a.x - b.x) <= RECT_UPDATE_TOLERANCE
        && Math.abs(a.y - b.y) <= RECT_UPDATE_TOLERANCE
        && Math.abs(a.width - b.width) <= RECT_UPDATE_TOLERANCE
        && Math.abs(a.height - b.height) <= RECT_UPDATE_TOLERANCE
    );
}

type PopoverCommonProps = Readonly<{
    open: boolean;
    /**
     * Legacy anchor prop. Kept for backwards compatibility — zero callsite changes needed.
     * If the new `anchor` prop is also provided, `anchor` wins.
     */
    anchorRef?: React.RefObject<any>;
    /**
     * Tagged-union anchor. Supersedes `anchorRef` when provided.
     *
     * - `{ kind: 'view', ref }` — classic view-ref measurement.
     * - `{ kind: 'rect', rect: { left, top, width?, height } }` — host-supplied window-relative rect;
     *   skips anchor-ref measurement but the full portal/boundary/keyboard pipeline still runs.
     */
    anchor?: PopoverAnchor;
    /**
     * Explicit focus-return ref for Escape key handling.
     * View-anchor callers can default this to the anchor ref.
     * Rect-anchor callers should pass the composer/editor input ref, or omit for no focus return.
     *
     * When omitted, falls back to `anchorRef` (view-anchor) or `anchor.ref` (view anchor via `anchor` prop).
     */
    focusReturnRef?: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    /**
     * Web-only: scroll container to subscribe to for anchor-tracking recomputes.
     *
     * This is intentionally separate from `boundaryRef` so we can keep popovers clamped to the
     * viewport while still following internal ScrollViews/lists.
     *
     * If omitted, Popover will fall back to any `PopoverScrollSourceProvider` in context.
     * Passing `null` explicitly disables internal scroll subscriptions.
     */
    followScrollRef?: React.RefObject<any> | null;
    placement?: PopoverPlacement;
    gap?: number;
    maxHeightCap?: number;
    maxWidthCap?: number;
    portal?: PopoverPortalOptions;
    /**
     * Adds padding around the popover content inside the anchored container.
     * This is the easiest way to ensure the popover doesn't sit flush against
     * the anchor/container edges, especially when using `left: 0, right: 0`.
     */
    edgePadding?: number | Readonly<{ horizontal?: number; vertical?: number }>;
    /** Extra styles applied to the positioned popover container. */
    containerStyle?: StyleProp<ViewStyle>;
    /**
     * When true (web only), clicking the anchor while the popover is open will also close it.
     * Useful for trigger chips that behave like toggles, especially when global pointerdown-capture
     * close handlers run before the anchor's press handler.
     */
    closeOnAnchorPress?: boolean;
    /**
     * When closing on an outside pointer-down on web, whether to consume the event by stopping
     * propagation. Defaults to true (safer for nested Radix/Vaul layers), but may be disabled
     * for popovers where outside clicks should still "go through" (for example, switching between
     * agent-input chips without needing a second click).
     */
    consumeOutsidePointerDown?: boolean;
    /**
     * Native-only bottom viewport occlusion supplied by a canonical keyboard source.
     *
     * When omitted, Popover falls back to React Native Keyboard events. Supplying this avoids
     * stale placement when the keyboard was already visible before the popover opened.
     */
    keyboardBottomInset?: number;
    children: (render: PopoverRenderProps) => React.ReactNode;
}>;

type PopoverWithBackdrop = PopoverCommonProps & Readonly<{
    backdrop?: true | PopoverBackdropOptions | undefined;
    onRequestClose: () => void;
}>;

type PopoverWithoutBackdrop = PopoverCommonProps & Readonly<{
    backdrop: false | (PopoverBackdropOptions & Readonly<{ enabled: false }>);
    onRequestClose?: () => void;
}>;

export function Popover(props: PopoverWithBackdrop | PopoverWithoutBackdrop) {
    const {
        open,
        anchorRef: anchorRefLegacy,
        anchor: anchorProp,
        focusReturnRef: focusReturnRefProp,
        boundaryRef: boundaryRefProp,
        followScrollRef: followScrollRefProp,
        placement = 'auto',
        gap = 8,
        maxHeightCap = 400,
        maxWidthCap = 520,
        onRequestClose,
        edgePadding = 0,
        backdrop,
        containerStyle,
        children,
    } = props;
    const keyboardBottomInsetProp = props.keyboardBottomInset;

    // Resolve the canonical anchor mode.
    // The new `anchor` prop wins if both `anchor` and `anchorRef` are provided (backwards-compat).
    const resolvedAnchorMode: 'view' | 'rect' = anchorProp
        ? anchorProp.kind
        : 'view';
    const emptyRefStable = React.useRef(null);
    const anchorRef: React.RefObject<any> = (() => {
        if (anchorProp?.kind === 'view') return anchorProp.ref;
        if (anchorRefLegacy) return anchorRefLegacy;
        // Rect mode with no view ref — provide a stable empty ref.
        return emptyRefStable;
    })();
    // Stabilize the rect anchor to avoid unnecessary recomputes when the host re-renders with the
    // same numeric values. Compare individual fields instead of object identity.
    const rectAnchorLeft = anchorProp?.kind === 'rect' ? anchorProp.rect.left : 0;
    const rectAnchorTop = anchorProp?.kind === 'rect' ? anchorProp.rect.top : 0;
    const rectAnchorWidth = anchorProp?.kind === 'rect' ? (anchorProp.rect.width ?? 1) : 0;
    const rectAnchorHeight = anchorProp?.kind === 'rect' ? anchorProp.rect.height : 0;
    const anchorRectFromProp: PopoverWindowRect | null = React.useMemo(() => {
        if (resolvedAnchorMode !== 'rect') return null;
        return {
            x: rectAnchorLeft,
            y: rectAnchorTop,
            width: rectAnchorWidth,
            height: rectAnchorHeight,
        };
    }, [resolvedAnchorMode, rectAnchorLeft, rectAnchorTop, rectAnchorWidth, rectAnchorHeight]);
    // Resolve the focus-return ref: explicit prop > view-anchor ref > null.
    const resolvedFocusReturnRef: React.RefObject<any> | undefined = (() => {
        if (focusReturnRefProp) return focusReturnRefProp;
        if (anchorProp?.kind === 'view') return anchorProp.ref;
        if (anchorRefLegacy) return anchorRefLegacy;
        return undefined;
    })();

    const boundaryFromContext = usePopoverBoundaryRef();
    const scrollSourceFromContext = usePopoverScrollSourceRef();
    // `boundaryRef` can be provided explicitly (including `null`) to override any boundary from context.
    // This is useful when a PopoverBoundaryProvider is present (e.g. inside an Expo Router modal) but a
    // particular popover should instead be constrained to the viewport.
    const boundaryRef = boundaryRefProp === undefined ? boundaryFromContext : boundaryRefProp;
    const followScrollRef = followScrollRefProp === undefined ? scrollSourceFromContext : followScrollRefProp;
    const { width: windowWidth, height: windowHeight } = useWindowDimensions();
    const overlayPortal = useOverlayPortal();
    const modalPortalTarget = useModalPortalTarget();
    const portalTarget = usePopoverPortalTarget();
    const portalWeb = props.portal?.web;
    const portalNative = props.portal?.native;
    const defaultPortalTargetOnWeb: 'body' | 'boundary' | 'modal' =
        modalPortalTarget ? 'modal' : 'body';
    const portalTargetOnWeb =
        typeof portalWeb === 'object' && portalWeb
            ? (portalWeb.target ?? defaultPortalTargetOnWeb)
            : defaultPortalTargetOnWeb;
    const matchAnchorWidthOnPortal = props.portal?.matchAnchorWidth ?? true;
    const anchorAlignOnPortal = props.portal?.anchorAlign ?? 'start';
    const anchorAlignVerticalOnPortal = props.portal?.anchorAlignVertical ?? 'center';

    const shouldPortalWeb = Platform.OS === 'web' && Boolean(portalWeb);
    const shouldPortalNative = Platform.OS !== 'web' && Boolean(portalNative) && Boolean(overlayPortal);
    const shouldPortal = shouldPortalWeb || shouldPortalNative;
    const shouldUseOverlayPortalOnNative = shouldPortalNative;
    const nativePortalShadowOutset = shouldUseOverlayPortalOnNative ? NATIVE_PORTAL_SHADOW_OUTSET : 0;
    const portalIdRef = React.useRef<string | null>(null);
    if (portalIdRef.current === null) {
        portalIdRef.current = `popover-${Math.random().toString(36).slice(2)}`;
    }
    const contentContainerRef = React.useRef<any>(null);
    const popoverModalPortalTargetRef = React.useRef<HTMLElement | null>(null);
    if (popoverModalPortalTargetRef.current === null) {
        popoverModalPortalTargetRef.current = createWebPopoverModalPortalTarget();
    }
    const popoverModalPortalHostRef = React.useRef<HTMLElement | null>(null);
    const setPopoverModalPortalHostRef = React.useCallback((node: HTMLElement | null) => {
        const target = popoverModalPortalTargetRef.current;
        const previousHost = popoverModalPortalHostRef.current;
        if (previousHost === node) return;

        if (target && previousHost) {
            try {
                previousHost.removeChild(target);
            } catch {
                // ignore detach failures during popover teardown
            }
        }

        popoverModalPortalHostRef.current = node;

        if (target && node) {
            try {
                node.appendChild(target);
            } catch {
                // ignore attach failures and let nested modals fall back to their own default
            }
        }
    }, []);
    const reducedMotion = useReducedMotionPreference();
    const uiBackdropBlurEnabled = useLocalSetting('uiBackdropBlurEnabled') !== false;
    const popoverMotionPreset = React.useMemo(
        () => resolveOverlayMotionPreset({ kind: 'popover' }),
        [],
    );
    const overlayPresence = useOverlayPresence(
        open,
        reducedMotion ? 0 : popoverMotionPreset.exitMs,
    );
    const shouldRender = overlayPresence.present;

    const getDomElementFromNode = React.useCallback((candidate: any): HTMLElement | null => {
        let node: any = candidate;
        const visited = new Set<any>();

        while (node && !visited.has(node)) {
            visited.add(node);

            if (typeof node.contains === 'function') {
                return node as HTMLElement;
            }

            const scrollable = node.getScrollableNode?.();
            if (scrollable && typeof scrollable.contains === 'function') {
                return scrollable as HTMLElement;
            }

            if (typeof node.getNode === 'function') {
                node = node.getNode();
                continue;
            }
            if (typeof node.getHostNode === 'function') {
                node = node.getHostNode();
                continue;
            }
            if (typeof node.getDOMNode === 'function') {
                node = node.getDOMNode();
                continue;
            }

            break;
        }

        return null;
    }, []);

    const getContentDomElement = React.useCallback((): HTMLElement | null => {
        const byRef = getDomElementFromNode(contentContainerRef.current);
        if (byRef) return byRef;

        if (Platform.OS !== 'web') return null;
        if (!shouldPortalWeb) return null;
        if (typeof document === 'undefined') return null;

        const id = portalIdRef.current;
        if (typeof id !== 'string' || id.length === 0) {
            return null;
        }
        if (typeof document.getElementById === 'function') {
            const candidate = document.getElementById(id);
            if (candidate && typeof (candidate as any).contains === 'function') {
                return candidate as HTMLElement;
            }
        }

        // RN-web maps `testID` to `data-testid`; keep a secondary fallback in case the ref can't be unwrapped.
        if (typeof document.querySelector === 'function') {
            const candidate = document.querySelector(`[data-testid="${id}"]`);
            if (candidate && typeof (candidate as any).contains === 'function') {
                return candidate as HTMLElement;
            }
        }

        return null;
    }, [getDomElementFromNode, shouldPortalWeb]);

    const getBoundaryDomElement = React.useCallback((): HTMLElement | null => {
        const boundaryNode = boundaryRef?.current as any;
        if (!boundaryNode) return null;
        const isDomPortalTarget = (candidate: any): candidate is HTMLElement => {
            return Boolean(
                candidate
                && typeof candidate.addEventListener === 'function'
                && typeof candidate.appendChild === 'function',
            );
        };

        // Direct DOM element (RN-web View ref often is the DOM element)
        if (isDomPortalTarget(boundaryNode)) {
            return boundaryNode;
        }

        // RN ScrollView refs often expose getScrollableNode()
        const scrollable = boundaryNode.getScrollableNode?.();
        if (isDomPortalTarget(scrollable)) {
            return scrollable;
        }

        // React Native Web host refs can expose getNode() to reach the DOM element.
        const node = boundaryNode.getNode?.();
        if (isDomPortalTarget(node)) {
            return node;
        }

        // Last resort: use the shared unwrapping logic (handles nested wrappers), then validate.
        const unwrapped = getDomElementFromNode(boundaryNode);
        if (isDomPortalTarget(unwrapped)) {
            return unwrapped;
        }

        return null;
    }, [boundaryRef, getDomElementFromNode]);

    const getScrollSourceDomElement = React.useCallback((): HTMLElement | null => {
        const scrollSourceNode = followScrollRef?.current as any;
        if (!scrollSourceNode) return null;

        const isDomScrollSource = (candidate: any): candidate is HTMLElement => {
            return Boolean(
                candidate
                && typeof candidate.addEventListener === 'function'
                && typeof candidate.removeEventListener === 'function',
            );
        };

        if (isDomScrollSource(scrollSourceNode)) return scrollSourceNode;

        const scrollable = scrollSourceNode.getScrollableNode?.();
        if (isDomScrollSource(scrollable)) return scrollable;

        const unwrapped = getDomElementFromNode(scrollSourceNode);
        if (isDomScrollSource(unwrapped)) return unwrapped;

        return null;
    }, [followScrollRef, getDomElementFromNode]);

    const getWebPortalTarget = React.useCallback((): HTMLElement | null => {
        if (Platform.OS !== 'web') return null;
        if (portalTargetOnWeb === 'modal') return (modalPortalTarget as any) ?? null;
        if (portalTargetOnWeb === 'boundary') return getBoundaryDomElement();
        return typeof document !== 'undefined' ? document.body : null;
    }, [getBoundaryDomElement, modalPortalTarget, portalTargetOnWeb]);

    const portalPositionOnWeb: ViewStyle['position'] =
        Platform.OS === 'web' && shouldPortalWeb && portalTargetOnWeb !== 'body'
            ? 'absolute'
            : ('fixed' as any);
    const webPortalTarget = shouldPortalWeb ? getWebPortalTarget() : null;
    const webPortalTargetRect =
        shouldPortalWeb && portalTargetOnWeb !== 'body'
            ? webPortalTarget?.getBoundingClientRect?.() ?? null
            : null;
    // When positioning `absolute` inside a scrollable container, account for its scroll offset.
    // Otherwise, the portal content is shifted by `-scrollTop`/`-scrollLeft` (it appears to drift
    // upward/left as you scroll the boundary). Using (rect - scroll) means later `top - offset`
    // effectively adds scroll back in.
    const portalScrollLeft = portalPositionOnWeb === 'absolute' ? (webPortalTarget as any)?.scrollLeft ?? 0 : 0;
    const portalScrollTop = portalPositionOnWeb === 'absolute' ? (webPortalTarget as any)?.scrollTop ?? 0 : 0;
    const webPortalOffsetX = (webPortalTargetRect?.left ?? webPortalTargetRect?.x ?? 0) - portalScrollLeft;
    const webPortalOffsetY = (webPortalTargetRect?.top ?? webPortalTargetRect?.y ?? 0) - portalScrollTop;

    const [computed, setComputed] = React.useState<PopoverRenderProps>(() => ({
        maxHeight: maxHeightCap,
        maxWidth: maxWidthCap,
        placement: placement === 'auto' || placement === 'auto-vertical'
            ? 'top'
            : placement === 'auto-horizontal'
                ? 'right'
                : placement,
    }));
    const popoverMotionDirection = resolveOverlayMotionDirectionFromPlacement(computed.placement);
    const [anchorRectState, setAnchorRectState] = React.useState<WindowRect | null>(null);
    const [boundaryRectState, setBoundaryRectState] = React.useState<WindowRect | null>(null);
    const [contentRectState, setContentRectState] = React.useState<WindowRect | null>(null);
    const isMountedRef = React.useRef(true);
    React.useEffect(() => {
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    const edgeInsets = React.useMemo(() => {
        const horizontal =
            typeof edgePadding === 'number'
                ? edgePadding
                : (edgePadding.horizontal ?? 0);
        const vertical =
            typeof edgePadding === 'number'
                ? edgePadding
                : (edgePadding.vertical ?? 0);

        return { horizontal, vertical };
    }, [edgePadding]);

    const keyboardHeightRef = React.useRef(0);

    const recompute = React.useCallback(async () => {
        if (!open) return;

        const measureOnce = async (): Promise<boolean> => {
            const anchorNode = resolvedAnchorMode === 'view' ? (anchorRef.current as any) : null;
            const boundaryNodeRaw = boundaryRef?.current as any;
            const portalRootNode =
                Platform.OS !== 'web' && shouldPortalNative
                    ? (portalTarget?.rootRef?.current as any)
                    : null;
            // On web, if boundary is a ScrollView ref, measure the real scrollable node to match
            // the element we attach scroll listeners to. This reduces coordinate mismatches.
            const boundaryNode =
                Platform.OS === 'web'
                    ? (boundaryNodeRaw?.getScrollableNode?.() ?? boundaryNodeRaw)
                    : boundaryNodeRaw;
            const keyboardHeightRaw =
                Platform.OS === 'web'
                    ? 0
                    : (keyboardBottomInsetProp ?? keyboardHeightRef.current ?? 0);
            const keyboardHeight = typeof keyboardHeightRaw === 'number' && Number.isFinite(keyboardHeightRaw)
                ? Math.max(0, keyboardHeightRaw)
                : 0;

            let anchorRect: WindowRect | null = null;
            let anchorIsPortalRelative = false;

            // --- Rect-anchor fast path (D35) ---
            // When the host supplies a window-relative rect, skip anchor-node measurement entirely.
            // For native portals, convert to portal-relative by subtracting the portal root's window rect.
            // Do NOT call measureLayout (there is no anchor node).
            if (resolvedAnchorMode === 'rect' && anchorRectFromProp) {
                if (portalRootNode) {
                    const portalLayout = portalTarget?.layout;
                    const portalLayoutWidth = portalLayout?.width ?? 0;
                    const portalLayoutHeight = portalLayout?.height ?? 0;
                    const hasPortalLayout = portalLayoutWidth > 0 && portalLayoutHeight > 0;

                    const portalRootWindowRect = await measureInWindow(portalRootNode);
                    if (portalRootWindowRect) {
                        const deltaRect: WindowRect = {
                            x: anchorRectFromProp.x - portalRootWindowRect.x,
                            y: anchorRectFromProp.y - portalRootWindowRect.y,
                            width: anchorRectFromProp.width,
                            height: anchorRectFromProp.height,
                        };
                        // Plausibility guard: if the delta would place the anchor outside the portal
                        // layout (e.g. negative coords from a coordinate-space mismatch), use the
                        // raw window rect if it fits better within the portal layout.
                        const withinPortalLayout = (rect: WindowRect | null): boolean => {
                            if (!rect) return false;
                            if (!hasPortalLayout) return true;
                            const tolerance = 16;
                            if (rect.x < -tolerance) return false;
                            if (rect.y < -tolerance) return false;
                            if (rect.x + rect.width > portalLayoutWidth + tolerance) return false;
                            if (rect.y + rect.height > portalLayoutHeight + tolerance) return false;
                            return true;
                        };
                        if (withinPortalLayout(deltaRect)) {
                            anchorRect = deltaRect;
                        } else if (withinPortalLayout(anchorRectFromProp)) {
                            // The window rect is already portal-relative (iOS contained presentation quirk).
                            anchorRect = anchorRectFromProp;
                        } else {
                            anchorRect = deltaRect;
                        }
                    } else {
                        // Cannot measure portal root; use the supplied window rect as-is.
                        anchorRect = anchorRectFromProp;
                    }
                    anchorIsPortalRelative = true;
                } else {
                    // No portal — use the supplied window-relative rect directly.
                    anchorRect = anchorRectFromProp;
                }
            }

            // --- View-anchor path (existing logic, unchanged) ---
            if (!anchorRect && resolvedAnchorMode === 'view') {
            if (portalRootNode) {
                const portalLayout = portalTarget?.layout;
                const portalLayoutWidth = portalLayout?.width ?? 0;
                const portalLayoutHeight = portalLayout?.height ?? 0;
                const hasPortalLayout = portalLayoutWidth > 0 && portalLayoutHeight > 0;
                const withinPortalLayout = (rect: WindowRect | null): boolean => {
                    if (!rect) return false;
                    if (!hasPortalLayout) return true;
                    // Allow a small tolerance so anchors on edges aren't treated as invalid.
                    const tolerance = 16;
                    if (rect.x < -tolerance) return false;
                    if (rect.y < -tolerance) return false;
                    if (rect.x + rect.width > portalLayoutWidth + tolerance) return false;
                    if (rect.y + rect.height > portalLayoutHeight + tolerance) return false;
                    return true;
                };

                // Prefer deriving portal-relative coords from window measurements (reliable when
                // `measureLayout` reports inconsistent offsets in iOS sheets/drawers). However,
                // `measure`/`measureInWindow` can also occasionally return coordinates in a different
                // space than the portal root (yielding negative/way-off deltas). In that case, fall
                // back to `measureLayout`.
                const relativeFromWindowDelta = async (): Promise<Readonly<{
                    deltaRect: WindowRect;
                    anchorWindowRect: WindowRect;
                }> | null> => {
                    if (Platform.OS === 'web') return null;
                    const portalRootWindowRect = await measureInWindow(portalRootNode);
                    const anchorWindowRect = await measureInWindow(anchorNode);
                    if (!portalRootWindowRect || !anchorWindowRect) return null;
                    const deltaRect: WindowRect = {
                        x: anchorWindowRect.x - portalRootWindowRect.x,
                        y: anchorWindowRect.y - portalRootWindowRect.y,
                        width: anchorWindowRect.width,
                        height: anchorWindowRect.height,
                    };
                    return { deltaRect, anchorWindowRect };
                };

                const relativeFromLayout = async (): Promise<WindowRect | null> => {
                    return await measureLayoutRelativeTo(anchorNode, portalRootNode);
                };

                const [deltaResult, layoutRect] = await Promise.all([
                    relativeFromWindowDelta(),
                    relativeFromLayout(),
                ]);

                const deltaRect = deltaResult?.deltaRect ?? null;
                const anchorWindowRect = deltaResult?.anchorWindowRect ?? null;

                // Choose the portal-relative anchor rect. The iOS `measureLayout` arbiter is
                // intentionally scoped to iOS; on Android the window-delta is authoritative.
                // See `resolvePortalRelativeAnchorRect` for the full coordinate-space rationale.
                const chosen = resolvePortalRelativeAnchorRect({
                    deltaRect,
                    layoutRect,
                    anchorWindowRect,
                    hasPortalLayout,
                    withinPortalLayout,
                    keyboardHeight,
                    platformOS: Platform.OS,
                });

                if (chosen) {
                    anchorRect = chosen;
                    anchorIsPortalRelative = true;
                }

                if (!anchorRect) {
                    // If the portal root cannot be measured (can happen with react-native-screens
                    // modal presentations), fall back to boundary-relative window measurements as
                    // a last resort.
                    const boundaryWindowRect = boundaryNode ? await measureInWindow(boundaryNode) : null;
                    const anchorWindowRect = await measureInWindow(anchorNode);
                    const originWindowRect = boundaryWindowRect;
                    if (originWindowRect && anchorWindowRect) {
                        anchorRect = {
                            x: anchorWindowRect.x - originWindowRect.x,
                            y: anchorWindowRect.y - originWindowRect.y,
                            width: anchorWindowRect.width,
                            height: anchorWindowRect.height,
                        };
                        anchorIsPortalRelative = true;
                    }
                }
            }

            if (!anchorRect) {
                anchorRect = await measureInWindow(anchorNode);
            }
            } // end view-anchor block

            const boundaryRectRaw = await (async () => {
                // IMPORTANT: Keep anchor + boundary in the same coordinate space.
                // If we position using portal-root-relative anchor coords (measureLayout), then using
                // a window-relative boundary (measureInWindow) can clamp the menu off-screen.
                if (portalRootNode && anchorIsPortalRelative) {
                    const relativeBoundary = boundaryNode ? await measureLayoutRelativeTo(boundaryNode, portalRootNode) : null;
                    if (relativeBoundary) return relativeBoundary;

                    const targetLayout = portalTarget?.layout;
                    if (targetLayout && targetLayout.width > 0 && targetLayout.height > 0) {
                        return { x: 0, y: 0, width: targetLayout.width, height: targetLayout.height };
                    }

                    const rootRect = await measureInWindow(portalRootNode);
                    if (rootRect?.width && rootRect?.height) {
                        return { x: 0, y: 0, width: rootRect.width, height: rootRect.height };
                    }

                    // As a last resort, try to derive portal-relative boundary geometry from window
                    // measurements when `measureLayout` is not available on the boundary node.
                    const boundaryWindowRect = boundaryNode ? await measureInWindow(boundaryNode) : null;
                    if (rootRect && boundaryWindowRect) {
                        return {
                            x: boundaryWindowRect.x - rootRect.x,
                            y: boundaryWindowRect.y - rootRect.y,
                            width: boundaryWindowRect.width,
                            height: boundaryWindowRect.height,
                        };
                    }

                    return null;
                }

                if (portalRootNode) {
                    const relativeBoundary = boundaryNode ? await measureLayoutRelativeTo(boundaryNode, portalRootNode) : null;
                    if (relativeBoundary) return relativeBoundary;
                    const targetLayout = portalTarget?.layout;
                    if (targetLayout && targetLayout.width > 0 && targetLayout.height > 0) {
                        return { x: 0, y: 0, width: targetLayout.width, height: targetLayout.height };
                    }
                }

                return boundaryNode ? measureInWindow(boundaryNode) : Promise.resolve(null);
            })();

            if (!isMountedRef.current) return false;
            if (!anchorRect) return false;
            // When portaling (web/native), a zero-sized anchor can cause the popover to render in
            // the wrong place (often overlapping the trigger). Treat it as an invalid measurement
            // and retry a couple times to allow layout to settle.
            // In rect mode, width is optional (defaults to 1) so we skip the width check.
            if ((shouldPortalWeb || shouldPortalNative) && resolvedAnchorMode === 'view' && (anchorRect.width <= 1 || anchorRect.height <= 1)) {
                return false;
            }

            const boundaryRectBase =
                boundaryRectRaw ??
                (portalRootNode && portalTarget?.layout?.width && portalTarget?.layout?.height
                    ? { x: 0, y: 0, width: portalTarget.layout.width, height: portalTarget.layout.height }
                    : getFallbackBoundaryRect({ windowWidth, windowHeight }));

            // Treat the on-screen keyboard as reducing the usable bottom viewport. Without this,
            // `placement="auto"` can flip a menu into the region covered by the keyboard, making it
            // look like the popover disappeared.
            const boundaryRect: WindowRect =
                keyboardHeight > 0
                    ? {
                        ...boundaryRectBase,
                        height: Math.max(0, boundaryRectBase.height - keyboardHeight),
                    }
                    : boundaryRectBase;

            // Shrink the usable boundary so the popover doesn't sit flush to the container edges.
            // (This also makes maxHeight/maxWidth clamping respect the margin.)
            const effectiveBoundaryRect: WindowRect = {
                x: boundaryRect.x + edgeInsets.horizontal,
                y: boundaryRect.y + edgeInsets.vertical,
                width: Math.max(0, boundaryRect.width - edgeInsets.horizontal * 2),
                height: Math.max(0, boundaryRect.height - edgeInsets.vertical * 2),
            };

            const availableTop = (anchorRect.y - effectiveBoundaryRect.y) - gap;
            const availableBottom = (effectiveBoundaryRect.y + effectiveBoundaryRect.height - (anchorRect.y + anchorRect.height)) - gap;
            const availableLeft = (anchorRect.x - effectiveBoundaryRect.x) - gap;
            const availableRight = (effectiveBoundaryRect.x + effectiveBoundaryRect.width - (anchorRect.x + anchorRect.width)) - gap;

            const resolvedPlacement = resolvePlacement({
                placement,
                preferredMinAvailable: placement === 'auto-horizontal' ? maxWidthCap : maxHeightCap,
                available: {
                    top: availableTop,
                    bottom: availableBottom,
                    left: availableLeft,
                    right: availableRight,
                },
            });

            const maxHeightAvailable =
                resolvedPlacement === 'bottom'
                    ? availableBottom
                    : resolvedPlacement === 'top'
                        ? availableTop
                        : effectiveBoundaryRect.height - gap * 2;

            const maxWidthAvailable =
                resolvedPlacement === 'right'
                    ? availableRight
                    : resolvedPlacement === 'left'
                        ? availableLeft
                        : effectiveBoundaryRect.width - gap * 2;

            const nextMaxHeight = Math.max(0, Math.min(maxHeightCap, Math.floor(maxHeightAvailable)));
            const nextMaxWidth = Math.max(0, Math.min(maxWidthCap, Math.floor(maxWidthAvailable)));
            // Treat "no available space" as an invalid transient measurement. On native (especially Android),
            // early measurements can occasionally report temporary boundary/anchor geometry that would yield
            // maxHeight/maxWidth = 0, which makes popovers appear collapsed. Retrying a couple frames later
            // avoids getting stuck at 0-height.
            if (nextMaxHeight < 1 || nextMaxWidth < 1) {
                return false;
            }

            const nextComputed: PopoverRenderProps = {
                placement: resolvedPlacement,
                maxHeight: nextMaxHeight,
                maxWidth: nextMaxWidth,
            };

            setComputed((prev) => arePopoverRenderPropsEqual(prev, nextComputed) ? prev : nextComputed);
            setAnchorRectState((prev) => areWindowRectsEqual(prev, anchorRect) ? prev : anchorRect);
            setBoundaryRectState((prev) => areWindowRectsEqual(prev, effectiveBoundaryRect) ? prev : effectiveBoundaryRect);
            return true;
        };

        const scheduleFrame = (cb: () => void) => {
            // In some test/non-browser environments, rAF may be missing.
            // Prefer rAF when available so layout has a chance to settle.
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(cb);
                return;
            }
            if (typeof queueMicrotask === 'function') {
                queueMicrotask(cb);
                return;
            }
            setTimeout(cb, 0);
        };

        // On web and native portal overlays, layout can "settle" a frame later (especially when opening).
        // If the initial measurement returns invalid values, retry a couple times so we don't get stuck
        // with incorrect placement or invisible portal content.
        const measureWithRetries = async (attempt: number) => {
            const ok = await measureOnce();
            if (ok) return;
            if (!isMountedRef.current) return;
            // Web portal anchors can transiently report 0x0 (or nearly 0x0) for a few frames after
            // opening. Retrying more than a couple frames avoids “invisible popover until second click”.
            if (attempt >= 5) return;
            scheduleFrame(() => {
                void measureWithRetries(attempt + 1);
            });
        };

        // Measure immediately rather than a frame later. The popover is INVISIBLE until this lands
        // (`portalOpacity` returns 0 while `anchorRectState` is null) and the enter animation is
        // gated on the same state, so a leading frame is dead time on every open — the user sees
        // nothing at all, not a slow popover. The anchor is already laid out (it is the element
        // that was tapped) and Fabric resolves `measure` in-tick off the shadow tree, so there is
        // nothing to wait for. The retry ladder above still yields a frame BETWEEN attempts, which
        // is what actually handles the "layout settles late" case this used to cover.
        void measureWithRetries(0);
    }, [anchorRef, anchorRectFromProp, boundaryRef, edgeInsets.horizontal, edgeInsets.vertical, gap, keyboardBottomInsetProp, maxHeightCap, maxWidthCap, open, placement, resolvedAnchorMode, shouldPortalNative, shouldPortalWeb, windowHeight, windowWidth, portalTarget]);

    React.useLayoutEffect(() => {
        if (!open) return;
        recompute();
    }, [open, recompute]);

    React.useEffect(() => {
        if (!open) return;
        if (Platform.OS !== 'web') return;

        let timer: number | null = null;
        const debounceMs = 90;

        const schedule = () => {
            if (timer !== null) window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                timer = null;
                recompute();
            }, debounceMs);
        };

        window.addEventListener('resize', schedule);

        const scrollSourceEl = shouldPortalWeb ? getScrollSourceDomElement() : null;
        // Only subscribe to window scroll when we portal to `document.body` (fixed positioning).
        // For portals mounted inside modal/boundary targets (absolute positioning), recomputing on
        // every scroll can cause jank on mobile web; use `followScrollRef` to opt-in to tracking an
        // internal scroll container when needed.
        const shouldSubscribeToWindowScroll = shouldPortalWeb && portalTargetOnWeb === 'body';

        if (shouldSubscribeToWindowScroll) {
            window.addEventListener('scroll', schedule, { passive: true } as any);
        }

        // Prefer an explicit scroll source over boundary-derived heuristics.
        // (Boundary refs are primarily for clamping; scroll tracking should be independent.)
        const legacyBoundaryScrollEl =
            !scrollSourceEl && shouldSubscribeToWindowScroll
                ? getBoundaryDomElement()
                : null;

        if (scrollSourceEl) {
            scrollSourceEl.addEventListener('scroll', schedule, { passive: true } as any);
        } else if (legacyBoundaryScrollEl) {
            // Back-compat: if no explicit scroll source is provided, keep subscribing to the boundary
            // scroll container for fixed-position portals (RN-web ScrollViews).
            legacyBoundaryScrollEl.addEventListener('scroll', schedule, { passive: true } as any);
        }
        return () => {
            if (timer !== null) window.clearTimeout(timer);
            window.removeEventListener('resize', schedule);
            if (shouldSubscribeToWindowScroll) {
                window.removeEventListener('scroll', schedule as any);
            }
            if (scrollSourceEl) {
                scrollSourceEl.removeEventListener('scroll', schedule as any);
            } else if (legacyBoundaryScrollEl) {
                legacyBoundaryScrollEl.removeEventListener('scroll', schedule as any);
            }
        };
    }, [getBoundaryDomElement, getScrollSourceDomElement, open, portalTargetOnWeb, recompute, shouldPortalWeb]);

    React.useEffect(() => {
        if (!open) return;
        if (Platform.OS === 'web') return;
        if (keyboardBottomInsetProp !== undefined) return;
        let timer: any = null;
        let subs: Array<{ remove: () => void }> = [];

        const debounceMs = 60;
        const schedule = () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                // Debounced after the keyboard event; `recompute()` already includes frame-retry
                // logic to avoid transient 0/incorrect rects.
                recompute();
            }, debounceMs);
        };

        // Prefer `willChangeFrame` for interactive keyboard dismissal; fall back to show/hide.
        const events = [
            'keyboardWillChangeFrame',
            'keyboardDidChangeFrame',
            'keyboardWillShow',
            'keyboardDidShow',
            'keyboardWillHide',
            'keyboardDidHide',
        ] as const;

        const getKeyboardHeightFromEvent = (e: any): number | null => {
            const h = e?.endCoordinates?.height;
            if (typeof h === 'number' && Number.isFinite(h) && h >= 0) return h;
            return null;
        };

        const handleKeyboardEvent = (event: (typeof events)[number]) => {
            return (e: unknown) => {
                if (event.includes('Hide')) {
                    keyboardHeightRef.current = 0;
                } else {
                    const next = getKeyboardHeightFromEvent(e as any);
                    if (next !== null) {
                        keyboardHeightRef.current = next;
                    }
                }
                schedule();
            };
        };

        // Subscribe synchronously so we don't miss the first keyboard transition.
        // (Async module resolution here has proven flaky in tests and can delay subscription
        // enough that a fast open->focus sequence misses the show event.)
        const keyboard: any = Keyboard as any;
        if (!keyboard || typeof keyboard.addListener !== 'function') return;

        subs = events
            .map((event) => {
                try {
                    return keyboard.addListener(event, handleKeyboardEvent(event));
                } catch {
                    return null;
                }
            })
            .filter(Boolean) as Array<{ remove: () => void }>;

        return () => {
            if (timer !== null) clearTimeout(timer);
            for (const sub of subs) {
                try {
                    sub.remove();
                } catch {
                    // ignore
                }
            }
        };
    }, [keyboardBottomInsetProp, open, recompute]);

    const fixedPositionOnWeb = (Platform.OS === 'web' ? ('fixed' as any) : 'absolute') as ViewStyle['position'];

    /**
     * Single owner of "how tall is the coordinate space this popover lays out in".
     *
     * On native with an overlay portal, both the content container and the backdrop are children of
     * `OverlayPortalHost`'s `absoluteFill` inside the screen-local portal root, and `anchorRectState`
     * is portal-relative (see `resolvePortalRelativeAnchorRect`). Anything derived from that anchor
     * must be measured against the portal root's height, not the window's — on an iOS
     * `containedModal` the two differ by the presentation inset plus the nav header.
     *
     * Every consumer (placement pinning here, the above-anchor dismiss frame in `backdrop.tsx`)
     * reads this value so the two can never disagree again.
     */
    const portalSpaceHeight = React.useMemo(() => {
        if (Platform.OS === 'web' || !shouldPortalNative) return windowHeight;
        const nativePortalHeight = portalTarget?.layout?.height;
        return typeof nativePortalHeight === 'number' && nativePortalHeight > 0
            ? nativePortalHeight
            : windowHeight;
    }, [portalTarget?.layout?.height, shouldPortalNative, windowHeight]);

    const placementStyle: ViewStyle = (() => {
        // On web, optional: render as a viewport-fixed overlay so it can escape any overflow:hidden ancestors.
        // This is especially important for headers/sidebars which often clip overflow.
        if (shouldPortal && anchorRectState) {
            const boundaryRect = boundaryRectState ?? getFallbackBoundaryRect({ windowWidth, windowHeight });
            const position = Platform.OS === 'web' && shouldPortalWeb ? portalPositionOnWeb : fixedPositionOnWeb;
            const desiredWidth = (() => {
                // Preserve historical sizing: for top/bottom, the popover was anchored to the
                // container width (left:0,right:0) and capped by maxWidth. The closest equivalent
                // in portal+fixed mode is to optionally cap width to anchor width.
                if (computed.placement === 'top' || computed.placement === 'bottom') {
                    return matchAnchorWidthOnPortal
                        ? Math.min(computed.maxWidth, Math.floor(anchorRectState.width))
                        : computed.maxWidth;
                }
                // For left/right, menus are typically content-sized; use computed maxWidth.
                return computed.maxWidth;
            })();

            const left = (() => {
                if (computed.placement === 'left') {
                    return anchorRectState.x - gap - desiredWidth;
                }
                if (computed.placement === 'right') {
                    return anchorRectState.x + anchorRectState.width + gap;
                }
                // top/bottom
                const desiredLeftRaw = (() => {
                    switch (anchorAlignOnPortal) {
                        case 'end':
                            return anchorRectState.x + anchorRectState.width - desiredWidth;
                        case 'center':
                            return anchorRectState.x + (anchorRectState.width - desiredWidth) / 2;
                        case 'start':
                        default:
                            return anchorRectState.x;
                    }
                })();
                return desiredLeftRaw;
            })();

            const top = (() => {
                if (computed.placement === 'left' || computed.placement === 'right') {
                    const contentHeight = contentRectState?.height ?? computed.maxHeight;
                    const desiredTopRaw = (() => {
                        switch (anchorAlignVerticalOnPortal) {
                            case 'end':
                                return anchorRectState.y + anchorRectState.height - contentHeight;
                            case 'start':
                                return anchorRectState.y;
                            case 'center':
                            default:
                                return anchorRectState.y + (anchorRectState.height - contentHeight) / 2;
                        }
                    })();

                    return Math.min(
                        boundaryRect.y + boundaryRect.height - contentHeight,
                        Math.max(boundaryRect.y, desiredTopRaw),
                    );
                }

                // top/bottom
                const contentHeight = contentRectState?.height ?? computed.maxHeight;
                const topForBottom = Math.min(
                    boundaryRect.y + boundaryRect.height - contentHeight,
                    Math.max(boundaryRect.y, anchorRectState.y + anchorRectState.height + gap),
                );
                const topForTop = Math.max(
                    boundaryRect.y,
                    Math.min(boundaryRect.y + boundaryRect.height - contentHeight, anchorRectState.y - contentHeight - gap),
                );
                return computed.placement === 'top' ? topForTop : topForBottom;
            })();

            const clampedLeft = Math.min(
                boundaryRect.x + boundaryRect.width - desiredWidth,
                Math.max(boundaryRect.x, left),
            );

            const verticalStyle: ViewStyle = (() => {
                // Prefer anchoring the edge closest to the anchor so the popover doesn’t “jiggle”
                // when its content height changes after opening (e.g. async-loaded trees/lists).
                //
                // For top-placed portals we can pin the bottom edge to (anchorTop - gap) using `bottom`,
                // which avoids depending on the measured content height for vertical positioning.
                if (computed.placement === 'top') {
                    const anchorTopInPortalSpace =
                        position === 'absolute'
                            ? (anchorRectState.y - webPortalOffsetY)
                            : anchorRectState.y;
                    const portalHeight = Platform.OS !== 'web'
                        ? portalSpaceHeight
                        : (position === 'absolute'
                            ? (webPortalTargetRect?.height ?? windowHeight)
                            : windowHeight);
                    const boundaryBottomInPortalSpace =
                        position === 'absolute'
                            ? boundaryRect.y + boundaryRect.height - webPortalOffsetY
                            : boundaryRect.y + boundaryRect.height;
                    const pinnedBottomEdge = Math.min(
                        anchorTopInPortalSpace - gap,
                        boundaryBottomInPortalSpace,
                    );
                    return {
                        bottom: Math.floor(portalHeight - pinnedBottomEdge - nativePortalShadowOutset),
                    } as any;
                }

                return {
                    top: Math.floor(top - (position === 'absolute' ? webPortalOffsetY : 0) - nativePortalShadowOutset),
                } as any;
            })();

            return {
                position,
                left: Math.floor(clampedLeft - (position === 'absolute' ? webPortalOffsetX : 0) - nativePortalShadowOutset),
                ...verticalStyle,
                zIndex: 1000,
                width:
                    computed.placement === 'top' ||
                    computed.placement === 'bottom' ||
                    computed.placement === 'left' ||
                    computed.placement === 'right'
                        ? desiredWidth + (nativePortalShadowOutset * 2)
                        : undefined,
            };
        }

        switch (computed.placement) {
            case 'top':
                return { position: 'absolute', bottom: '100%', left: 0, right: 0, marginBottom: gap, zIndex: 1000 };
            case 'bottom':
                return { position: 'absolute', top: '100%', left: 0, right: 0, marginTop: gap, zIndex: 1000 };
            case 'left':
                return { position: 'absolute', right: '100%', top: 0, marginRight: gap, zIndex: 1000 };
            case 'right':
                return { position: 'absolute', left: '100%', top: 0, marginLeft: gap, zIndex: 1000 };
        }
    })();

    const portalOpacity = (() => {
        // Web portal popovers should not "jiggle" (render in one place then snap).
        // Hide them until we have enough layout info to position them correctly.
        if (!shouldPortalWeb && !shouldPortalNative) return 1;
        if (!anchorRectState) return 0;
        if (
            (computed.placement === 'top' || computed.placement === 'bottom') &&
            shouldPortalWeb &&
            (!contentRectState || contentRectState.height < 1)
        ) {
            return 0;
        }
        if (
            (computed.placement === 'left' || computed.placement === 'right') &&
            anchorAlignVerticalOnPortal !== 'start' &&
            (!contentRectState || contentRectState.height < 1)
        ) {
            return 0;
        }
        return 1;
    })();
    const motionVisible = open && (!(shouldPortalWeb || shouldPortalNative) || portalOpacity > 0);

    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!open) return;
        if (!shouldPortalWeb) return;

        const contentEl = getContentDomElement();
        if (!contentEl) return;
        if (typeof contentEl.getBoundingClientRect !== 'function') return;

        let isCancelled = false;

        const measure = () => {
            if (isCancelled) return;
            const rect = contentEl.getBoundingClientRect();
            const width = rect?.width;
            const height = rect?.height;
            if (![width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) return;

            const next: WindowRect = { x: 0, y: 0, width, height };
            // Avoid rerender loops from tiny float changes
            setContentRectState((prev) => {
                if (!prev) return next;
                if (Math.abs(prev.width - next.width) > 1 || Math.abs(prev.height - next.height) > 1) {
                    return next;
                }
                return prev;
            });
        };

        // Read after initial paint so the element has a stable box even when portaled.
        const raf = (globalThis.requestAnimationFrame ?? ((cb: FrameRequestCallback) => {
            cb(0);
            return 0;
        }))(measure);

        let resizeObserver: ResizeObserver | null = null;
        try {
            resizeObserver = new ResizeObserver(() => {
                measure();
            });
            resizeObserver.observe(contentEl);
        } catch {
            // Best-effort only: ResizeObserver isn't available in every environment.
        }

        return () => {
            isCancelled = true;
            if (typeof globalThis.cancelAnimationFrame === 'function') {
                globalThis.cancelAnimationFrame(raf);
            }
            resizeObserver?.disconnect();
        };
    }, [getContentDomElement, open, shouldPortalWeb]);

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside portaled popovers.
        // Stopping propagation here keeps the event within the popover subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (!shouldPortalWeb) return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, [shouldPortalWeb]);

    // IMPORTANT: hooks must not be conditional. This must run even when `open === false`
    // to avoid changing hook order between renders.
    const paddingStyle = React.useMemo<ViewStyle>(() => {
        const horizontal =
            typeof edgePadding === 'number'
                ? edgePadding
                : (edgePadding.horizontal ?? 0);
        const vertical =
            typeof edgePadding === 'number'
                ? edgePadding
                : (edgePadding.vertical ?? 0);

        if (computed.placement === 'top' || computed.placement === 'bottom') {
            return horizontal > 0 ? { paddingHorizontal: horizontal } : {};
        }
        if (computed.placement === 'left' || computed.placement === 'right') {
            return vertical > 0 ? { paddingVertical: vertical } : {};
        }
        return {};
    }, [computed.placement, edgePadding]);

    const nativePortalShadowPaddingStyle = React.useMemo<ViewStyle>(() => {
        return addPaddingOutset([paddingStyle, containerStyle], nativePortalShadowOutset);
    }, [containerStyle, nativePortalShadowOutset, paddingStyle]);
    const contentContainerMaxWidth = computed.maxWidth + (nativePortalShadowOutset * 2);

    // Must be above BaseModal (100000) and other header overlays.
    const portalZ = POPOVER_PORTAL_Z_INDEX;

    const backdropEnabled =
        typeof backdrop === 'boolean'
            ? backdrop
            : (backdrop?.enabled ?? true);
    const backdropOutsidePointerEventsOption =
        typeof backdrop === 'object' && backdrop
            ? (backdrop.blockOutsidePointerEvents ?? (Platform.OS === 'web' ? false : true))
            : (Platform.OS === 'web' ? false : true);
    const backdropBlocksOutsidePointerEvents = Boolean(backdropOutsidePointerEventsOption);
    const backdropOutsidePointerEventsMode: PopoverOutsidePointerEventsMode =
        backdropOutsidePointerEventsOption === 'above-anchor'
            ? 'above-anchor'
            : 'full';
    const backdropEffect: PopoverBackdropEffect =
        typeof backdrop === 'object' && backdrop
            ? (backdrop.effect ?? 'none')
            : 'none';
    const resolvedBackdropEffect: PopoverBackdropEffect =
        backdropEffect === 'blur' && !uiBackdropBlurEnabled
            ? 'dim'
            : backdropEffect;
    const backdropBlurOnWeb = typeof backdrop === 'object' && backdrop ? backdrop.blurOnWeb : undefined;
    const backdropSpotlight = typeof backdrop === 'object' && backdrop ? (backdrop.spotlight ?? false) : false;
    const backdropAnchorOverlay = typeof backdrop === 'object' && backdrop ? backdrop.anchorOverlay : undefined;
    const backdropStyle = typeof backdrop === 'object' && backdrop ? backdrop.style : undefined;
    const closeOnBackdropPan = typeof backdrop === 'object' && backdrop ? (backdrop.closeOnPan ?? false) : false;
    const backdropPointerEventsEnabled =
        !overlayPresence.exiting
        && (!(shouldPortalWeb || shouldPortalNative) || portalOpacity !== 0);

    useEscapeLayer({
        enabled: Platform.OS === 'web' && open && typeof onRequestClose === 'function',
        priority: ESCAPE_LAYER_PRIORITIES.popover,
        allowEditableTarget: true,
        focusReturnRef: resolvedFocusReturnRef,
        onEscape: () => {
            onRequestClose?.();
            return true;
        },
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!open) return;
        if (!onRequestClose) return;
        if (typeof document === 'undefined') return;

        const shouldAttachPointerDownCapture = !(backdropEnabled && backdropBlocksOutsidePointerEvents);
        const handlePointerDownCapture = (event: Event) => {
            const target = event.target as Node | null;
            if (!target) return;
            const contentEl = getContentDomElement();
            if (contentEl && contentEl.contains(target)) return;
            const anchorEl = getDomElementFromNode(anchorRef.current);
            // If we cannot resolve the DOM elements (common with RN-web refs in portaled subtrees),
            // fail open: do not swallow the click. This avoids breaking in-popover interactions.
            if (!contentEl && !anchorEl) return;
            if (anchorEl && anchorEl.contains(target)) {
                if (props.closeOnAnchorPress) {
                    onRequestClose();
                }
                return;
            }

            const shouldConsumeOutsidePointerDown = props.consumeOutsidePointerDown ?? true;
            if (shouldConsumeOutsidePointerDown) {
                // Prevent nested Radix/Vaul "outside click" logic from also dismissing the underlying modal.
                event.stopPropagation();
                event.stopImmediatePropagation();
                onRequestClose();
                return;
            }

            // On web, allow the outside click to be handled by its actual target (for example: another
            // chip trigger). Close the popover in the next task to avoid interfering with the click.
            setTimeout(() => onRequestClose(), 0);
        };

        if (shouldAttachPointerDownCapture) {
            document.addEventListener('pointerdown', handlePointerDownCapture, true);
        }
        return () => {
            if (shouldAttachPointerDownCapture) {
                document.removeEventListener('pointerdown', handlePointerDownCapture, true);
            }
        };
    }, [
        anchorRef,
        backdropBlocksOutsidePointerEvents,
        backdropEnabled,
        getContentDomElement,
        onRequestClose,
        open,
        props.closeOnAnchorPress,
    ]);

    const content = shouldRender ? (
        <>
            <PopoverBackdrop
                backdrop={backdropEnabled ? backdrop : false}
                backdropBlocksOutsidePointerEvents={backdropBlocksOutsidePointerEvents}
                backdropOutsidePointerEventsMode={backdropOutsidePointerEventsMode}
                backdropEffect={resolvedBackdropEffect}
                backdropBlurOnWeb={backdropBlurOnWeb}
                backdropSpotlight={backdropSpotlight}
                backdropAnchorOverlay={backdropAnchorOverlay}
                backdropStyle={backdropStyle}
                closeOnBackdropPan={closeOnBackdropPan}
                backdropPointerEventsEnabled={backdropPointerEventsEnabled}
                onRequestClose={onRequestClose}
                shouldPortal={shouldPortal}
                shouldPortalWeb={shouldPortalWeb}
                portal={props.portal}
                portalOpacity={portalOpacity}
                portalPositionOnWeb={portalPositionOnWeb}
                fixedPositionOnWeb={fixedPositionOnWeb}
                portalZ={portalZ}
                anchorRect={anchorRectState}
                windowWidth={windowWidth}
                windowHeight={windowHeight}
                portalSpaceHeight={portalSpaceHeight}
                webPortalOffsetX={webPortalOffsetX}
                webPortalOffsetY={webPortalOffsetY}
            />
            <ViewWithWheel
                ref={contentContainerRef}
                {...(shouldPortalWeb
                    ? ({ onWheel: stopScrollEventPropagationOnWeb, onTouchMove: stopScrollEventPropagationOnWeb } as any)
                    : {})}
                {...(Platform.OS === 'web' && shouldPortalWeb
                    ? ({ nativeID: portalIdRef.current, testID: portalIdRef.current } as any)
                    : {})}
                style={[
                    placementStyle,
                    paddingStyle,
                    containerStyle,
                    nativePortalShadowPaddingStyle,
                    { maxWidth: contentContainerMaxWidth },
                    (shouldPortalWeb || shouldPortalNative) ? { opacity: portalOpacity } : null,
                    shouldPortal ? { zIndex: portalZ + 1 } : null,
                ]}
                pointerEvents={overlayPresence.exiting || ((shouldPortalWeb || shouldPortalNative) && portalOpacity === 0) ? 'none' : 'auto'}
                onLayout={(e) => {
                    // Used to improve portal alignment (especially left/right centering)
                    const layout = e?.nativeEvent?.layout;
                    if (!layout) return;
                    const next = { x: 0, y: 0, width: layout.width ?? 0, height: layout.height ?? 0 };
                    // Avoid rerender loops from tiny float changes
                    setContentRectState((prev) => {
                        if (!prev) return next;
                        if (Math.abs(prev.width - next.width) > 1 || Math.abs(prev.height - next.height) > 1) {
                            return next;
                        }
                        return prev;
                    });

                    // Measurement recovery.
                    //
                    // `recompute` retries on a fixed budget of animation frames. That budget encodes a
                    // *time* assumption ("layout settles within ~6 frames") which does not hold when the
                    // popover opens inside a freshly-presented contained modal, or while the JS thread is
                    // saturated. When it expires with no valid geometry, `anchorRectState` stays null,
                    // `portalOpacity` stays 0 and the popover is mounted but invisible and untappable —
                    // permanently, because nothing else re-runs `recompute` unless one of its inputs
                    // (window size, keyboard inset, portal-root layout, caps) happens to change.
                    //
                    // This layout event IS the platform reporting that the popover subtree now has
                    // geometry, so it re-arms measurement. It is self-terminating rather than a retry
                    // loop: it only fires while no anchor rect has ever been measured, and an unchanged
                    // layout emits no further events.
                    if (!anchorRectState) {
                        void recompute();
                    }
                }}
            >
                {Platform.OS === 'web' && shouldPortalWeb ? (
                    <>
                        <div
                            data-happy-popover-modal-portal-host=""
                            ref={setPopoverModalPortalHostRef}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: 0,
                                height: 0,
                                overflow: 'visible',
                            }}
                        />
                        <ModalPortalTargetProvider target={popoverModalPortalTargetRef.current}>
                            <OverlayMotionFrame
                                visible={motionVisible}
                                kind="popover"
                                direction={popoverMotionDirection}
                            >
                                {children(computed)}
                            </OverlayMotionFrame>
                        </ModalPortalTargetProvider>
                    </>
                ) : (
                    <OverlayMotionFrame
                        visible={motionVisible}
                        kind="popover"
                        direction={popoverMotionDirection}
                    >
                        {children(computed)}
                    </OverlayMotionFrame>
                )}
            </ViewWithWheel>
        </>
    ) : null;

    const contentWithRadixBranch = (() => {
        if (!content) return null;
        if (!shouldPortalWeb) return content;
        try {
            // IMPORTANT:
            // Use the CJS entrypoints (`require`) so Radix singletons (DismissableLayer stacks)
            // are shared with Vaul / expo-router on web. Without this, "outside click" logic
            // can treat portaled popovers as outside the active modal.
            const { Branch: DismissableLayerBranch } = requireRadixDismissableLayer();
            return (
                <DismissableLayerBranch>
                    {content}
                </DismissableLayerBranch>
            );
        } catch {
            return content;
        }
    })();

    useNativeOverlayPortalNode({
        overlayPortal,
        portalId: portalIdRef.current as string,
        enabled: shouldUseOverlayPortalOnNative,
        content,
    });

    if (!shouldRender) return null;

    const webPortal = tryRenderWebPortal({
        shouldPortalWeb,
        portalTargetOnWeb,
        modalPortalTarget: (modalPortalTarget as any) ?? null,
        getBoundaryDomElement,
        content: contentWithRadixBranch,
    });
    if (webPortal) return webPortal;

    if (shouldUseOverlayPortalOnNative) return null;
    return contentWithRadixBranch;
}
