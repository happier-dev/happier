import * as React from 'react';
import { PaneHeaderScrollIsolation } from '@/components/appShell/panes/paneHeaderScroll';
import { BackHandler, Keyboard, Platform, StyleSheet as RNStyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { usePopoverBoundaryRef } from './PopoverBoundary';
import { usePopoverScrollSourceRef } from './PopoverScrollSource';
import { requireRadixDismissableLayer } from '@/utils/web/radixCjs';
import { useLayerOverlayPortal, useOverlayPortal } from './OverlayPortal';
import {
    ModalPortalTargetProvider,
    useHasModalPortalTargetProvider,
    useModalLayerZIndex,
    useModalPortalTarget,
} from '@/modal/portal/ModalPortalTarget';
import { usePopoverPortalTarget } from './PopoverPortalTarget';
import {
    OverlayMotionFrame,
    resolveOverlayMotionDirectionFromPlacement,
    resolveOverlayMotionPreset,
    useOverlayPresence,
} from '@/components/ui/overlays/motion/overlayMotion';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import { useNativeBackLayerDescendant } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLayoutPresentationActive, useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { useRetainedPlacement } from '@/modal/components/RetainedModalFrame';
import type {
    PopoverAnchor,
    PopoverBackdropEffect,
    PopoverBackdropOptions,
    PopoverCloseReason,
    PopoverOutsidePointerEventsMode,
    PopoverPlacement,
    PopoverPortalOptions,
    PopoverRenderProps,
    PopoverWindowRect,
    ResolvedPopoverPlacement,
} from './_types';
import { getFallbackBoundaryRect, measureInWindow, measureLayoutRelativeTo } from './measure';
import { useWebPopoverContentMeasure } from './useWebPopoverContentMeasure';
import { resolvePortalRelativeAnchorRect } from './resolvePortalRelativeAnchor';
import { PopoverBackdrop } from './backdrop';
import { HOVER_CARD_PORTAL_Z_INDEX, POPOVER_PORTAL_Z_INDEX, tryRenderWebPortal, useNativeOverlayPortalNode } from './portal';
import { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer } from '@/keyboard/escape';
import {
    readDocumentFocusReturnTarget,
    restoreFocusToBestTarget,
    useFocusReturnFallbackRef,
    type FocusReturnTarget,
} from '@/keyboard/focusReturn';
import { resolveHappierPopoverPlacement } from '@happier-dev/plugin-ui/presentation';
import { resolvePopoverSideMaxHeight } from './resolvePopoverHeightStyle';
import { useDeviceType, usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { BaseModal } from '@/modal/components/BaseModal';
import { ModalCardFrame } from '@/modal/components/card/ModalCardFrame';
import { ModalBackButton } from '@/modal/components/card/ModalBackButton';
import { AnchoredPhonePushHost, createPhoneSheetPushStack, PhoneSheetPushBody, PhoneSheetPushContext, usePhoneSheetPush, type PhoneSheetPushStack } from './phoneSheetPush';
import { FloatingOverlayPhonePanelContext, FloatingOverlaySheetContext } from '@/components/ui/overlays/FloatingOverlay';
import { GlassOpenedLayer } from '@/components/ui/glass/GlassSurface';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { useSessionCockpitPageBottomClearance } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

const ViewWithWheel = View as unknown as React.ComponentType<ViewProps & { onWheel?: any }>;

export type {
    PopoverAnchor,
    PopoverBackdropEffect,
    PopoverBackdropOptions,
    PopoverCloseReason,
    PopoverOutsidePointerEventsMode,
    PopoverPlacement,
    PopoverPortalOptions,
    PopoverRenderProps,
    PopoverWindowRect,
    ResolvedPopoverPlacement,
} from './_types';

type WindowRect = PopoverWindowRect;
type PopoverLayoutProps = Omit<PopoverRenderProps, 'requestClose'>;

const RECT_UPDATE_TOLERANCE = 1;
const NATIVE_PORTAL_SHADOW_OUTSET = 16;
// A popover placed above its anchor hangs its content from the box's bottom edge (a gap above the anchor) through an
// auto top margin. Unlike end-aligning the box's content, an auto margin takes no negative room: content taller
// than its box starts at the box's top and never rises past it (QA-B3 r173, web 1280×577).
const TOP_PLACED_CONTENT_STYLE = { marginTop: 'auto' } as const satisfies ViewStyle;

/**
 * Width bounds of a content-sized popover (`portal.sizeToContent`): wide enough for a row's title
 * and status on one line, narrow enough to read as attached to the control that opened it.
 */
export const CONTENT_SIZED_POPOVER_WIDTH = {
    minPx: 240,
    maxPx: 360,
} as const;
const WEB_POPOVER_FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

type FocusableForOpen = { focus?: (options?: FocusOptions) => void };

/**
 * Moves focus into an opening popover without scrolling. The popover is focused before it is
 * measured and placed, so a scrolling focus makes the browser scroll the page to reveal the
 * still-unplaced popover: the whole app jumps sideways for a frame and then snaps back.
 */
function focusWithoutScrolling(target: FocusableForOpen): void {
    if (Platform.OS === 'web') target.focus?.({ preventScroll: true });
    else target.focus?.();
}

function readNumericStyleValue(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolvePaddingEdges(style: StyleProp<ViewStyle>): Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
}> {
    const flatStyle = RNStyleSheet.flatten(style) as ViewStyle | undefined;
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

function arePopoverRenderPropsEqual(a: PopoverLayoutProps, b: PopoverLayoutProps): boolean {
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
     * A popover is anchored to its trigger on every width (owner R2, 2026-11-09): menus, pickers and
     * account/Home popovers alike. On a phone this says how it sits there:
     * - `panel`: a menu, picker or account popover. On a phone it spans the screen less its gutters (the
     *   sheet's look) right above or below its trigger, which stays visible; opened inside another phone
     *   panel or sheet (a submenu, a row's picker) it replaces that one's content in place, with a Back.
     * - `sheet`: a form or reading panel (its own Done or footer, a long document) is the shared bottom
     *   sheet on a phone, and pushes like `panel` when opened inside one.
     */
    phonePresentation?: 'sheet' | 'panel';
    /** A form's completion control replaces the sheet's close button in the shared header. */
    sheetHeaderAction?: React.ReactNode;
    /** A form summary belongs under the title in the sheet's existing header. */
    sheetSubtitle?: string;
    /**
     * `none`: the content carries its own header (title, live meta, controls), so the sheet keeps
     * only its grabber; the accessibility label still names the dialog.
     */
    sheetHeader?: 'band' | 'none';
    /** `solid`: an opaque sheet, for live content that must not show the screen through it. */
    sheetMaterial?: 'glass' | 'solid';
    /**
     * `none`: no scrim or blur behind the sheet, for a sheet about something on the screen (the
     * tapped name in code, Home's look) that must stay readable above it: the sheet stops at half the
     * screen and its body scrolls. A tap outside still closes it.
     */
    sheetBackdrop?: 'scrim' | 'none';
    /** Controls pinned under the sheet's scrolling body (a filter sheet's Clear and Show results). */
    sheetFooter?: React.ReactNode;
    accessibilityLabel?: string;
    /** Move focus into the popover after it opens when the content is menu-like. */
    autoFocusOnOpen?: boolean;
    /** Dismiss a transient reading once its anchor leaves the measured viewport. */
    dismissWhenAnchorHidden?: boolean;
    /**
     * `hoverCard`: a preview the resting pointer opened (`useHoverPreviewPopover`'s `popoverLayer`). It stacks
     * under every popover or menu someone opened, whichever mounted last, so it never covers their rows.
     */
    layer?: 'hoverCard';
    anchorRef?: React.RefObject<any>;
    anchor?: PopoverAnchor;
    focusReturnRef?: React.RefObject<any>;
    /** Explicit physical target for menu-like autofocus; falls back to the content wrapper. */
    initialFocusRef?: React.RefObject<any>;
    boundaryRef?: React.RefObject<any> | null;
    /**
     * A view the popover never covers: a top/bottom popover opens beyond this view's top or bottom
     * edge instead of its anchor's, while still hanging horizontally from the anchor. A picker opened
     * from a chip inside a composer passes the composer, so the text being written stays visible.
     */
    clearanceRef?: React.RefObject<any>;
    /**
     * A view whose width the popover stays within, while `boundaryRef` (or the window) still sets its
     * vertical room: a picker opened from a chip near the end of a composer slides back inside the
     * composer's width instead of running past it.
     */
    horizontalBoundaryRef?: React.RefObject<any>;
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
    /** The tallest the popover may be. Defaults to the room its side of the anchor offers: content scrolls, never hides. */
    maxHeightCap?: number;
    maxWidthCap?: number;
    /**
     * The vertical room a side must offer before an `auto*` placement (or a flip) prefers it. Defaults to
     * the height cap. A menu whose height is bounded only by the window passes the room it usually
     * needs, so it still opens below its trigger when that room exists. A start-aligned side popover
     * (a submenu) likewise stays at its anchor row while the room below it holds this much. Sideways
     * side choice always uses `maxWidthCap`, since the free room there is a width.
     */
    placementMinSpace?: number;
    /**
     * The narrowest a content-sized popover (`portal.sizeToContent`) may be. Defaults to
     * `CONTENT_SIZED_POPOVER_WIDTH.minPx`, the compact-picker floor; a tooltip passes `0`.
     */
    minWidth?: number;
    /**
     * An explicit side that cannot hold `maxHeightCap` (`maxWidthCap` for left/right) moves to the
     * opposite side when that one has more room, instead of overlapping its anchor. `auto*`
     * placements already choose their side. Enabled by default; a caller can
     * opt out when retaining its explicit side is part of its presentation.
     */
    flip?: boolean;
    /**
     * What a top/bottom popover does when neither side of its anchor holds `maxHeightCap`.
     * `shrink` (default, menus and pickers) takes the larger side and scrolls inside it. `shift` keeps
     * a designed panel at its full size (up to the boundary) and slides it inside the boundary, over its
     * trigger if it must, so a surface opened mid-page is never cramped into the leftover room.
     */
    fit?: 'shrink' | 'shift';
    portal?: PopoverPortalOptions;
    /**
     * Adds padding around the popover content inside the anchored container.
     * This is the easiest way to ensure the popover doesn't sit flush against
     * the anchor/container edges, especially when using `left: 0, right: 0`.
     */
    edgePadding?: number | Readonly<{ horizontal?: number; vertical?: number; top?: number; bottom?: number }>;
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
     * agent-input chips without needing a second click). A consumed touch or pen press also drops its
     * click, so a finger that dismisses the popover never activates what lies under it.
     */
    consumeOutsidePointerDown?: boolean;
    /** In-page controls participating in this popover's interaction, outside its portal. */
    interactionBoundaryRef?: React.RefObject<unknown>;
    /**
     * A reading that follows the pointer (a chart's scrub lens): the popover never takes the pointer, so
     * the surface under it keeps its hover and scrub while the popover floats above every clip.
     */
    passive?: boolean;
    /**
     * Native-only bottom viewport occlusion supplied by a canonical keyboard source.
     *
     * When omitted, Popover falls back to React Native Keyboard events. Supplying this avoids
     * stale placement when the keyboard was already visible before the popover opened.
     */
    keyboardBottomInset?: number;
    /**
     * Hears the popover leave the screen once its exit has played (an anchored popover or a phone sheet), so an owner
     * keeping its record drops it then. A view pushed into another surface has no exit of its own.
     */
    onExited?: () => void;
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

/** Open web popovers; an anchor inside another's participating content belongs to that interaction. */
type OpenWebPopoverEntry = Readonly<{
    getContentElement: () => HTMLElement | null;
    getInteractionBoundaryElement: () => HTMLElement | null;
    getAnchorElement: () => HTMLElement | null;
}>;
const OPEN_WEB_POPOVERS: OpenWebPopoverEntry[] = [];

/**
 * Drops the click that completes a consumed outside press. It ends with that click, or with the next press
 * when the gesture never produced one (a drag), so it can never eat a later tap.
 */
function swallowNextClick(): void {
    const onClick = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        stop();
    };
    const stop = () => {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('pointerdown', stop, true);
    };
    document.addEventListener('click', onClick, true);
    // Added while this press is dispatching, so (per DOM dispatch) it first hears the next press.
    document.addEventListener('pointerdown', stop, true);
}

/**
 * Whether a popover opened from inside `owner` (its anchor sits in owner's content or interaction boundary) is still open. While it is, that
 * nested popover owns dismissal: a press inside it is not outside `owner`, and a press outside both closes only it.
 */
function hasOpenNestedWebPopover(owner: OpenWebPopoverEntry): boolean {
    const content = owner.getContentElement();
    const interactionBoundary = owner.getInteractionBoundaryElement();
    return OPEN_WEB_POPOVERS.some(entry => {
        if (entry === owner) return false;
        const anchor = entry.getAnchorElement();
        return anchor !== null && (content?.contains(anchor) === true || interactionBoundary?.contains(anchor) === true);
    });
}

/** Where a native popover waits, laid out but out of sight, until its placement is measured. */
const NATIVE_UNPLACED_STYLE = { transform: [{ translateX: -100000 }] } as const;

/** A phone panel's inset from the screen's sides: the composer's phone picker gutter. */
const PHONE_PANEL_GUTTER_PX = 12;

/** The room a top/bottom side must offer before it is preferred when the caller sets no cap. */
const DEFAULT_PREFERRED_ROOM_PX = 400;

type PopoverProps = PopoverWithBackdrop | PopoverWithoutBackdrop;

function resolveFocusReturnRef(props: Pick<PopoverProps, 'focusReturnRef' | 'anchor' | 'anchorRef'>) {
    return props.focusReturnRef ?? (props.anchor?.kind === 'view' ? props.anchor.ref : props.anchorRef);
}

/**
 * `auto` hangs a top/bottom popover from the anchor edge that faces the larger side of its boundary: a trigger
 * on the left opens rightward (it never spans the sidebar or rail beside it), one on the right opens leftward.
 */
function resolvePopoverAnchorEdge(
    align: NonNullable<PopoverPortalOptions['anchorAlign']>,
    anchor: Readonly<{ x: number; width: number }>,
    boundary: Readonly<{ x: number; width: number }>,
): 'start' | 'center' | 'end' {
    if (align !== 'auto') return align;
    const startRoom = boundary.x + boundary.width - anchor.x;
    const endRoom = anchor.x + anchor.width - boundary.x;
    return startRoom >= endRoom ? 'start' : 'end';
}

/**
 * A popover belongs to the page it was opened from. When that page stops being presented (an Open inside a
 * sheet shows the detail in place, a retained tab hides), the popover closes instead of staying over what
 * replaced it, and it does not come back when the page returns.
 */
function useCloseWhenPageWithdrawn(open: boolean, onRequestClose: (() => void) | undefined): void {
    const presentation = useLayoutPresentationSignal();
    const closeIfOpen = useEventCallback(() => {
        if (open && !presentation.get()) onRequestClose?.();
    });
    React.useEffect(() => presentation.subscribe(closeIfOpen), [closeIfOpen, presentation]);
}

/**
 * How far a presented body's events travel: a body is rendered at the Popover, away from its shell, so it stops
 * what its shell stopped. A portaled anchored popover keeps clicks and scrolls inside it; a sheet (a dialog) keeps
 * its presses; an inline popover or a view pushed into another surface lets them through as before.
 */
type PopoverBodyIsolation = 'portal' | 'dialog' | 'none';
type PopoverBodyArgs = Readonly<{ renderProps: PopoverRenderProps; isolation: PopoverBodyIsolation }>;
type PopoverShellProps = (PopoverProps extends infer Variant ? Variant extends unknown ? Omit<Variant, 'children'> : never : never) & Readonly<{
    /** The one mounted body, presented in this shell. */
    renderBody: (args: PopoverBodyArgs) => React.ReactElement;
    /** Private notification from the existing shell presence owner. */
    onPresentationAbsent: () => void;
}>;

const stopWebPropagation = (event: { stopPropagation?: () => void }) => { event.stopPropagation?.(); };
const PORTAL_ISOLATION = {
    onClick: stopWebPropagation, onPointerDown: stopWebPropagation, onTouchStart: stopWebPropagation,
    onWheel: stopWebPropagation, onTouchMove: stopWebPropagation,
} as const;
const DIALOG_ISOLATION = { onClick: stopWebPropagation, onPointerDown: stopWebPropagation, onTouchStart: stopWebPropagation } as const;
const NO_ISOLATION = {} as const;
const BODY_HOST_STYLE = { display: 'contents' } as const;

export function Popover(requested: PopoverProps) {
    const [retained, setRetained] = React.useState(requested.open);
    // Acquire on the opening render, then retain only until the existing presentation owner reports absence.
    if (requested.open && !retained) setRetained(true);
    const onPresentationAbsent = useEventCallback(() => {
        if (!requested.open) setRetained(false);
    });
    return requested.open || retained ? <PopoverPresentation {...requested} onPresentationAbsent={onPresentationAbsent} /> : null;
}

function PopoverPresentation(requested: PopoverProps & Readonly<{ onPresentationAbsent: () => void }>) {
    const deviceType = useDeviceType();
    // One mounted body across the anchored popover, the phone sheet and a view pushed into another surface: crossing
    // the phone breakpoint changes the shell, never the content (typed text, a picked source, an open step).
    const children = requested.children;
    const renderRetainedBody = React.useCallback((args: PopoverBodyArgs) => Platform.OS === 'web'
        ? <div style={BODY_HOST_STYLE} {...(args.isolation === 'portal' ? PORTAL_ISOLATION : args.isolation === 'dialog' ? DIALOG_ISOLATION : NO_ISOLATION)}>
            {children(args.renderProps)}
        </div>
        : children(args.renderProps), [children]);
    // A closed popover's body retires with its last shell, so it opens fresh next time.
    const retained = useRetainedPlacement(renderRetainedBody, requested.open ? RETAIN_WITHOUT_SHELL : RETIRE_WITHOUT_SHELL);
    // On web the outgoing shell can remain in a transition after its opener closes. Its actual slot,
    // not the open flag or a second animation clock, owns the retained portal body's lifetime.
    React.useEffect(() => {
        if (Platform.OS === 'web' && !requested.open && !retained.hasPlacement) requested.onPresentationAbsent();
    }, [requested.open, requested.onPresentationAbsent, retained.hasPlacement]);
    const onNativePresentationAbsent = useEventCallback(() => {
        if (Platform.OS !== 'web') requested.onPresentationAbsent();
    });
    useCloseWhenPageWithdrawn(requested.open, requested.onRequestClose);
    // A withdrawn page presents nothing, whether or not its opener has committed the close yet: a retained
    // page is frozen behind the content that replaced it, so its close may only land when it is shown again
    // (TL-C phone glance, READY161).
    const presented = useLayoutPresentationActive();
    const props = presented || !requested.open ? requested : { ...requested, open: false };
    // A submenu or form opened from inside a phone popover or sheet pushes into it (with a Back) instead of
    // opening a second surface over it.
    const pushStack = React.useContext(PhoneSheetPushContext);
    const phone = deviceType === 'phone';
    const { children: _body, onPresentationAbsent: _absent, ...shell } = props;
    const shellProps: PopoverShellProps = { ...shell, renderBody: retained.mount, onPresentationAbsent: onNativePresentationAbsent };
    // Placement measurements belong to the anchored presentation's mounted tree. A sheet
    // replaces that tree, so returning to desktop measures its new anchor and content afresh.
    // A menu's or picker's own scroll never drives the shade under the pane header it opens from.
    return <PaneHeaderScrollIsolation>
        {phone && pushStack && props.phonePresentation
            ? <PushedPhonePopover {...shellProps} stack={pushStack} />
            : phone && props.phonePresentation === 'sheet'
                ? <PhonePopoverSheet {...shellProps} />
                : <AnchoredPopoverPresence {...shellProps} />}
        {retained.body}
    </PaneHeaderScrollIsolation>;
}

const RETIRE_WITHOUT_SHELL = { retireWithoutShell: true } as const;
const RETAIN_WITHOUT_SHELL = { retireWithoutShell: false } as const;

function PushedPhonePopover(props: PopoverShellProps & Readonly<{ stack: PhoneSheetPushStack }>) {
    const { renderBody } = props;
    const render = React.useCallback((renderProps: PopoverRenderProps) => renderBody({ renderProps, isolation: 'none' }), [renderBody]);
    usePhoneSheetPush({
        stack: props.stack,
        open: props.open,
        title: props.sheetHeader === 'none' ? undefined : props.accessibilityLabel,
        subtitle: props.sheetSubtitle,
        onRequestClose: props.onRequestClose,
        render,
    });
    React.useEffect(() => {
        if (!props.open) props.onPresentationAbsent();
    }, [props.open, props.onPresentationAbsent]);
    return null;
}

function PhonePopoverSheet(props: PopoverShellProps) {
    const onPresenceChange = useEventCallback((present: boolean) => {
        if (!present) props.onPresentationAbsent();
    });
    // A sheet is a screen surface: hosted above its layer's chrome, never inside a page's popover scope.
    const layerOverlayPortal = useLayerOverlayPortal();
    const nearestOverlayPortal = useOverlayPortal();
    const overlayPortal = layerOverlayPortal ?? nearestOverlayPortal;
    const portalId = React.useId();
    const { width: windowWidth, height: windowHeight } = usePresentationWindowDimensions();
    const insets = useChromeSafeAreaInsets();
    // A sheet about the screen keeps the upper half of that screen in view (the first-open Home look sheet).
    const aboutScreen = props.sheetBackdrop === 'none';
    const frameHeight = aboutScreen ? Math.round(windowHeight / 2) : Math.max(0, windowHeight - insets.top);
    const maxHeight = Math.min(props.maxHeightCap ?? windowHeight, frameHeight, Math.max(0, windowHeight - insets.top - insets.bottom));
    // Stable, so the retained body is not republished (and re-rendered) on every render of the sheet.
    const closeSheet = useEventCallback(() => props.onRequestClose?.());
    // Views pushed inside this sheet (a row's picker): the band then names the top one and leads with Back.
    const [pushStack] = React.useState(createPhoneSheetPushStack);
    const pushed = React.useSyncExternalStore(pushStack.subscribe, pushStack.getChrome, pushStack.getChrome);
    const content = <BaseModal
        visible={props.open}
        onExited={props.onExited}
        onPresenceChange={onPresenceChange}
        onClose={closeSheet}
        onBack={pushed ? pushStack.back : undefined}
        placement="bottom"
        scrollHost="body"
        showBackdrop={props.sheetBackdrop !== 'none'}
        accessibilityLabel={props.accessibilityLabel}
        focusReturnRef={resolveFocusReturnRef(props)}
        focusReturnFallback="activation-time"
    >
        <ModalCardFrame
            presentation="sheet"
            scrollHost="bounded"
            bodyScroll="auto"
            header={pushed ? 'band' : props.sheetHeader}
            // The band stands on the menu text edge, over the menu's group titles and rows (D8).
            headerInset="menu"
            material={props.sheetMaterial}
            sheetBottomInset={insets.bottom}
            leading={pushed ? <ModalBackButton testID="popover-sheet.back" onPress={pushStack.back} /> : undefined}
            title={pushed ? pushed.title : props.accessibilityLabel}
            subtitle={pushed ? pushed.subtitle : props.sheetSubtitle}
            closeButtonTestID="popover-sheet.close"
            // Done replaces the close control, so it stays on the title's row (a phone stacks context actions).
            completion={pushed ? undefined : props.sheetHeaderAction}
            footer={pushed ? undefined : props.sheetFooter}
            onClose={props.onRequestClose && (pushed || !props.sheetHeaderAction) ? closeSheet : undefined}
            style={{ maxHeight: frameHeight }}
            bodyStyle={{ flexGrow: 0, paddingLeft: insets.left, paddingRight: insets.right }}
        >
            <FloatingOverlaySheetContext.Provider value={true}>
                <PhoneSheetPushBody stack={pushStack} renderProps={{
                    placement: 'bottom',
                    maxWidth: Math.max(0, windowWidth - insets.left - insets.right),
                    maxHeight,
                    presentation: 'sheet',
                    requestClose: closeSheet,
                }}>
                    {props.renderBody({
                        renderProps: {
                            placement: 'bottom',
                            maxWidth: Math.max(0, windowWidth - insets.left - insets.right),
                            maxHeight,
                            presentation: 'sheet',
                            requestClose: closeSheet,
                        },
                        isolation: 'dialog',
                    })}
                </PhoneSheetPushBody>
            </FloatingOverlaySheetContext.Provider>
        </ModalCardFrame>
    </BaseModal>;
    // A sheet opened by a composer or row needs the screen's native bounds for both
    // layout and hit testing, just like the anchored presentation below.
    useNativeOverlayPortalNode({
        overlayPortal,
        portalId,
        enabled: Platform.OS !== 'web',
        content,
    });
    return Platform.OS !== 'web' && overlayPortal ? null : content;
}

function AnchoredPopoverPresence(props: PopoverShellProps) {
    const reducedMotion = useReducedMotionPreference();
    const popoverMotionPreset = React.useMemo(
        () => resolveOverlayMotionPreset({ kind: 'popover' }),
        [],
    );
    const overlayPresence = useOverlayPresence(props.open, reducedMotion ? 0 : popoverMotionPreset.exitMs, props.onExited);
    React.useEffect(() => {
        if (!overlayPresence.present) props.onPresentationAbsent();
    }, [overlayPresence.present, props.onPresentationAbsent]);
    // Keep the existing exit lifetime, but acquire placement, portals and focus only while present.
    return overlayPresence.present ? <AnchoredPopover {...props} overlayPresence={overlayPresence} /> : null;
}

function AnchoredPopover(props: PopoverShellProps & Readonly<{ overlayPresence: ReturnType<typeof useOverlayPresence> }>) {
    const {
        open: requestedOpen,
        anchorRef: anchorRefLegacy,
        anchor: anchorProp,
        initialFocusRef: initialFocusRefProp,
        boundaryRef: boundaryRefProp,
        followScrollRef: followScrollRefProp,
        placement: requestedPlacement = 'auto',
        gap = 8,
        maxHeightCap: maxHeightCapProp,
        maxWidthCap: requestedMaxWidthCap = 520,
        minWidth: contentSizedMinWidth = CONTENT_SIZED_POPOVER_WIDTH.minPx,
        onRequestClose,
        edgePadding = 0,
        backdrop,
        containerStyle,
        renderBody,
    } = props;
    const open = requestedOpen;
    const closeForHiddenAnchor = props.dismissWhenAnchorHidden ? onRequestClose : undefined;
    const phone = useDeviceType() === 'phone';
    // A phone panel spans the screen less its gutters, above or below its trigger (`phonePresentation`).
    const spansPhone = phone && props.phonePresentation === 'panel';
    // ... whatever side its caller named: a side placement there left a menu narrow beside its trigger, or at the
    // top of the screen beside a trigger near the bottom (NATIVE-SWEEP L10: a draft's ⋯).
    const placement = spansPhone && (requestedPlacement === 'left' || requestedPlacement === 'right' || requestedPlacement === 'auto-horizontal')
        ? 'auto-vertical' : requestedPlacement;
    const keyboardBottomInsetProp = props.keyboardBottomInset;
    const autoFocusOnOpen = props.autoFocusOnOpen === true;
    const resolvedAnchorMode: 'view' | 'rect' = anchorProp ? anchorProp.kind : 'view';
    const emptyRefStable = React.useRef(null);
    const anchorRef: React.RefObject<any> = (() => {
        if (anchorProp?.kind === 'view') return anchorProp.ref;
        if (anchorRefLegacy) return anchorRefLegacy;
        return emptyRefStable;
    })();
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
    const resolvedFocusReturnRef = resolveFocusReturnRef(props);

    const boundaryFromContext = usePopoverBoundaryRef();
    const scrollSourceFromContext = usePopoverScrollSourceRef();
    // `boundaryRef` can be provided explicitly (including `null`) to override any boundary from context.
    // This is useful when a PopoverBoundaryProvider is present (e.g. inside an Expo Router modal) but a
    // particular popover should instead be constrained to the viewport.
    const boundaryRef = boundaryRefProp === undefined ? boundaryFromContext : boundaryRefProp;
    const followScrollRef = followScrollRefProp === undefined ? scrollSourceFromContext : followScrollRefProp;
    const { width: windowWidth, height: windowHeight } = usePresentationWindowDimensions();
    const maxWidthCap = spansPhone ? windowWidth : requestedMaxWidthCap;
    // Without an explicit cap a popover takes whatever room its side offers (content scrolls inside it);
    // the room a side must offer to be preferred stays the usual menu height.
    const maxHeightCap = maxHeightCapProp ?? windowHeight;
    const preferredRoom = maxHeightCapProp ?? DEFAULT_PREFERRED_ROOM_PX;
    const overlayPortal = useOverlayPortal();
    // The native portal host renders outside this tree; a live picture under the anchor still sets the coat there.
    const overLivePicture = React.useContext(GlassLivePictureBackdropContext);
    const modalPortalTarget = useModalPortalTarget();
    const modalLayerZIndex = useModalLayerZIndex();
    const hasModalPortalTargetProvider = useHasModalPortalTargetProvider();
    const portalTarget = usePopoverPortalTarget();
    const portalWeb = props.portal?.web;
    const portalNative = props.portal?.native;
    const defaultPortalTargetOnWeb: 'body' | 'boundary' | 'modal' =
        hasModalPortalTargetProvider ? 'modal' : 'body';
    const portalTargetOnWeb =
        typeof portalWeb === 'object' && portalWeb
            ? (portalWeb.target ?? defaultPortalTargetOnWeb)
            : defaultPortalTargetOnWeb;
    const matchAnchorWidthOnPortal = props.portal?.matchAnchorWidth ?? true;
    const sizesToAnchorExplicitly = props.portal?.matchAnchorWidth === true;
    const anchorAlignOnPortal = props.portal?.anchorAlign ?? 'start';
    const anchorAlignVerticalOnPortal = props.portal?.anchorAlignVertical ?? 'center';
    const topBottomLayoutOnPortal = spansPhone ? 'boundary' : props.portal?.topBottomLayout ?? 'anchored';
    const sizeToContentOnPortal = props.portal?.sizeToContent === true && topBottomLayoutOnPortal === 'anchored';
    // A content-sized popover centred on its anchor (a tooltip) is placed from its measured width.
    const centresMeasuredContent = sizeToContentOnPortal && anchorAlignOnPortal === 'center';

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
    const focusReturnFallbackRef = useFocusReturnFallbackRef<FocusReturnTarget>();
    const activationFocusReturnRef = React.useRef<FocusReturnTarget>(null);
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || !open || typeof document === 'undefined') {
            activationFocusReturnRef.current = null;
            return;
        }

        // Positioning can be anchored to a non-focusable wrapper. Capture the
        // actual activation target before this menu moves focus into its portal
        // so close can still return there after the portal unmounts.
        activationFocusReturnRef.current = readDocumentFocusReturnTarget(document);
    }, [open]);
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
                // Ignore detach failures during popover teardown.
            }
        }

        popoverModalPortalHostRef.current = node;

        if (target && node) {
            try {
                node.appendChild(target);
            } catch {
                // Ignore attach failures and let nested modals fall back to their own default.
            }
        }
    }, []);
    const overlayPresence = props.overlayPresence;

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

    const focusInitialTarget = React.useCallback((): boolean => {
        const target = initialFocusRefProp?.current as FocusableForOpen | null | undefined;
        if (typeof target?.focus !== 'function') return false;
        focusWithoutScrolling(target);
        return true;
    }, [initialFocusRefProp]);
    const openingFocus = React.useRef({ autoFocusOnOpen, focusInitialTarget, getContentDomElement });
    openingFocus.current = { autoFocusOnOpen, focusInitialTarget, getContentDomElement };

    // Arm cancellation in the opening commit, before the browser can deliver
    // input to the still-focused field while the asynchronous content is empty.
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || !open || !openingFocus.current.autoFocusOnOpen || typeof document === 'undefined') {
            return;
        }

        let pending = true;
        const stopPendingFocus = () => {
            pending = false;
            observer?.disconnect();
            document.removeEventListener('keydown', stopPendingFocus, true);
            document.removeEventListener('pointerdown', stopPendingFocus, true);
            document.removeEventListener('input', stopPendingFocus, true);
            document.removeEventListener('focusin', stopPendingFocus, true);
        };

        const focusFirstInteractiveDescendant = () => {
            if (!pending) return;

            const content = openingFocus.current.getContentDomElement();
            const activeElement = document.activeElement;
            if (content && activeElement && content.contains(activeElement)) {
                stopPendingFocus();
                return;
            }

            // Menus nominate their roving row through the adapter. Prefer it
            // over generic DOM discovery so controlled radio selection and
            // initial keyboard focus remain one fact.
            if (openingFocus.current.focusInitialTarget()) {
                stopPendingFocus();
                return;
            }

            const focusableCandidates = content
                ? Array.from(content.querySelectorAll<HTMLElement>(WEB_POPOVER_FOCUSABLE_SELECTOR)).filter((candidate) => (
                    candidate.getAttribute('aria-disabled') !== 'true'
                    && !candidate.hasAttribute('disabled')
                ))
                : [];
            const target = focusableCandidates.find((candidate) => (
                candidate.getAttribute('aria-selected') === 'true'
            )) ?? focusableCandidates[0] ?? null;
            if (target) {
                focusWithoutScrolling(target);
                stopPendingFocus();
            }
        };

        // Content may mount after an asynchronous options read, or in a portal
        // committed after this effect. Observe readiness until the opening focus
        // intent is fulfilled; any subsequent user input/focus cancels it.
        const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(focusFirstInteractiveDescendant);
        observer?.observe(openingFocus.current.getContentDomElement() ?? document.documentElement, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['disabled', 'aria-disabled', 'tabindex', 'aria-selected'],
        });
        document.addEventListener('keydown', stopPendingFocus, true);
        document.addEventListener('pointerdown', stopPendingFocus, true);
        document.addEventListener('input', stopPendingFocus, true);
        document.addEventListener('focusin', stopPendingFocus, true);
        focusFirstInteractiveDescendant();
        return stopPendingFocus;
        // Rendered options and focus adapters may change while this intent is
        // pending or cancelled. Only another opening, or a press taking over an
        // open hover preview (`autoFocusOnOpen` turning true), may arm it again.
    }, [autoFocusOnOpen, open]);

    React.useEffect(() => {
        if (Platform.OS === 'web' || !open || !openingFocus.current.autoFocusOnOpen) {
            return;
        }

        // Native portal nodes are committed through the incumbent OverlayPortal
        // layout effect. Defer one microtask so a portal-host state update can
        // attach this ref first; callers never need their own focus lifecycle.
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            if (!openingFocus.current.focusInitialTarget()) {
                contentContainerRef.current?.focus?.();
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open]);

    // Whether this close came through `requestClose`, which already decided where focus goes.
    const closeRequested = React.useRef(false);
    const requestClose = React.useCallback((reason: PopoverCloseReason) => {
        closeRequested.current = true;
        // A tooltip leaves focus on its trigger or another control. Returning it there
        // would steal focus and can reopen the tooltip through the trigger's focus handler.
        const ownsFocus = Platform.OS !== 'web' || (
            typeof document !== 'undefined' && getContentDomElement()?.contains(document.activeElement) === true
        );
        onRequestClose?.();
        if (reason !== 'dismiss' && ownsFocus) {
            const restored = restoreFocusToBestTarget(resolvedFocusReturnRef, activationFocusReturnRef);
            if (!restored) {
                restoreFocusToBestTarget(undefined, focusReturnFallbackRef);
            }
        }
    }, [focusReturnFallbackRef, getContentDomElement, onRequestClose, resolvedFocusReturnRef]);

    // Its content can close it too (a Done button turning `open` off or unmounting it). Focus then sits in the content
    // or, once the content left, nowhere; it goes back to the opener exactly as a requested close returns it (L04).
    // Only a popover that held focus gives it back. A tooltip never takes focus, and its trigger's own blur unmounts it
    // while the document focuses nothing for a moment: pulling focus back then would stop Tab at that trigger.
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || !open || typeof document === 'undefined') return;
        closeRequested.current = false;
        let heldFocus = getContentDomElement()?.contains(document.activeElement) === true;
        const noteFocus = (event: FocusEvent) => {
            if (!heldFocus && event.target instanceof Node && getContentDomElement()?.contains(event.target) === true) {
                heldFocus = true;
            }
        };
        document.addEventListener('focusin', noteFocus, true);
        return () => {
            document.removeEventListener('focusin', noteFocus, true);
            if (closeRequested.current || !heldFocus) return;
            const content = getContentDomElement();
            const stranded = () => {
                const focused = document.activeElement;
                return focused === null || focused === document.body || content?.contains(focused) === true;
            };
            const restore = () => {
                if (!stranded()) return;
                if (!restoreFocusToBestTarget(resolvedFocusReturnRef, activationFocusReturnRef)) {
                    restoreFocusToBestTarget(undefined, focusReturnFallbackRef);
                }
            };
            // Let the commit finish first: a retained body moving into a phone sheet restores its field there.
            // Only focus still stranded in this outgoing content (or nowhere) returns to the opener.
            queueMicrotask(restore);
        };
        // Read at close: the return targets and the content element are refs owned by this popover.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const requestAndroidBackClose = React.useCallback(() => {
        requestClose('back');
    }, [requestClose]);

    useNativeBackLayerDescendant(Platform.OS === 'android' && open && typeof onRequestClose === 'function');

    React.useEffect(() => {
        if (Platform.OS !== 'android' || !open || !onRequestClose) {
            return;
        }

        // React Native dispatches Android hardware Back in reverse registration
        // order and stops at the first `true`. Registering each active Popover
        // with the platform stack therefore preserves nested/topmost ordering
        // without creating a second overlay authority.
        const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
            requestAndroidBackClose();
            return true;
        });
        return () => {
            subscription.remove();
        };
    }, [onRequestClose, open, requestAndroidBackClose]);

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

    const [computed, setComputed] = React.useState<PopoverLayoutProps>(() => ({
        maxHeight: maxHeightCap,
        maxWidth: maxWidthCap,
        placement: placement === 'auto' || placement === 'auto-vertical' || placement === 'auto-horizontal' ? 'top' : placement,
    }));
    const [anchorRectState, setAnchorRectState] = React.useState<WindowRect | null>(null);
    const [boundaryRectState, setBoundaryRectState] = React.useState<WindowRect | null>(null);
    const [contentRectState, setContentRectState] = React.useState<WindowRect | null>(null);
    // The visible surface's height: a native portal box also carries the shadow outset above and below it, which
    // may bleed into the edge padding. Placing by the box height lifted a full-height panel over its trigger.
    const measuredSurfaceHeight = contentRectState
        ? Math.max(0, contentRectState.height - nativePortalShadowOutset * 2)
        : null;
    // Hung below its trigger, a box never stands taller than the cap it was given there (the room below). Content first
    // renders under the initial cap and is measured a frame after placement already gave it a smaller one: placing by
    // that older height lifted a field's picker over its field for a few frames before it snapped under (MACH-SANDBOX
    // r5). Above a trigger, and for a designed panel that keeps its own size (`fit: 'shift'`), the measured height stays
    // authoritative, so a box still out of date never starts above the window.
    const belowSurfaceHeight = measuredSurfaceHeight === null ? null : Math.min(measuredSurfaceHeight, computed.maxHeight);
    // The side the popover is shown on, which its position and its entrance both follow. A designed panel
    // (`fit: 'shift'`) that placement hung below its trigger is measured at its own height: when it does not fit
    // below but fits above, it opens above, whole, instead of sliding up over the trigger; it slides only when it
    // fits on neither side. Likewise a popover asked to open below that the room heuristic moved above (a short
    // dropdown low in a dialog) opens below after all once its measured content fits there, so it never covers
    // the field's own label and help line.
    const shownPlacement: PopoverLayoutProps['placement'] = (() => {
        if (!anchorRectState || measuredSurfaceHeight === null) return computed.placement;
        const shiftedPanel = computed.placement === 'bottom' && props.fit === 'shift';
        const flippedFromBottom = computed.placement === 'top' && placement === 'bottom';
        if (!shiftedPanel && !flippedFromBottom) return computed.placement;
        const boundary = boundaryRectState ?? getFallbackBoundaryRect({ windowWidth, windowHeight });
        const fitsBelow = anchorRectState.y + anchorRectState.height + gap + measuredSurfaceHeight <= boundary.y + boundary.height;
        if (flippedFromBottom) return fitsBelow ? 'bottom' : 'top';
        const fitsAbove = anchorRectState.y - gap - measuredSurfaceHeight >= boundary.y;
        return !fitsBelow && fitsAbove ? 'top' : 'bottom';
    })();
    const popoverMotionDirection = resolveOverlayMotionDirectionFromPlacement(shownPlacement);
    /**
     * Where an open side popover, or a designed panel (`fit: 'shift'`) shown above its trigger, first settled, as an
     * offset from its anchor's top. Content that grows after opening (a field expands, a sub-page pushes, a tab with
     * more fields) keeps this top and grows downward, rising only by what no longer fits; re-centring a side popover,
     * or pinning a panel's bottom to its trigger, moved the controls under the pointer on every height change.
     */
    const settledSideTopRef = React.useRef<Readonly<{ placement: 'left' | 'right' | 'top'; offset: number }> | null>(null);
    if (!open) settledSideTopRef.current = null;
    const isMountedRef = React.useRef(true);
    React.useLayoutEffect(() => {
        isMountedRef.current = true;
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
        // `top`/`bottom` refine one edge: room kept clear of window chrome above, say, without
        // taking the same room from below.
        const top = typeof edgePadding === 'number' ? edgePadding : (edgePadding.top ?? vertical);
        const bottom = typeof edgePadding === 'number' ? edgePadding : (edgePadding.bottom ?? vertical);

        return { horizontal: spansPhone ? Math.max(horizontal, PHONE_PANEL_GUTTER_PX) : horizontal, top, bottom };
    }, [edgePadding, spansPhone]);

    // The edge padding is a transparent gutter inside the popover's box (see `paddingStyle`): the
    // width a child may fill is the box less that gutter, never the box itself.
    // The edge margin is the gutter the box actually carries: a caller's `containerStyle` padding can
    // narrow it (the composer's pickers zero it), and the clamp then keeps the visible surface the full
    // margin from the window edge itself instead of assuming the gutter is there.
    const horizontalGutter = React.useMemo(() => {
        // A phone panel's boundary already stands its gutter in from the screen's sides; its box carries none.
        if (spansPhone || (computed.placement !== 'top' && computed.placement !== 'bottom')) return 0;
        const carried = resolvePaddingEdges([{ paddingHorizontal: edgeInsets.horizontal }, containerStyle]);
        return Math.max(0, Math.min(edgeInsets.horizontal, carried.left, carried.right));
    }, [computed.placement, containerStyle, edgeInsets.horizontal, spansPhone]);
    const contentMaxWidth = Math.max(0, computed.maxWidth - horizontalGutter * 2);
    // A side popover's box carries the vertical edge padding as a transparent gutter (`paddingStyle`): a submenu
    // (start-aligned) puts its surface, not that gutter, on its row's top edge.
    const sideVerticalGutter = React.useMemo(() => {
        if (computed.placement !== 'left' && computed.placement !== 'right') return 0;
        const vertical = typeof edgePadding === 'number' ? edgePadding : (edgePadding.vertical ?? 0);
        const carried = resolvePaddingEdges([{ paddingVertical: vertical }, containerStyle]);
        return Math.max(0, Math.min(vertical, carried.top));
    }, [computed.placement, containerStyle, edgePadding]);


    const keyboardHeightRef = React.useRef(0);
    // The shell's floating bottom chrome (tab bar, docked band) covers the page and reserves nothing, so the popover
    // treats it like the keyboard: as the bottom of the usable viewport (NATIVE-SWEEP L12: View options over the bar).
    const bottomChromeClearance = useSessionCockpitPageBottomClearance();
    // The status bar above a native screen: no popover runs under it (owner 19:16 item 01).
    const safeAreaTop = useChromeSafeAreaInsets().top;

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

            if (resolvedAnchorMode === 'rect' && anchorRectFromProp) {
                if (portalRootNode) {
                    const portalLayout = portalTarget?.layout;
                    const portalLayoutWidth = portalLayout?.width ?? 0;
                    const portalLayoutHeight = portalLayout?.height ?? 0;
                    const hasPortalLayout = portalLayoutWidth > 0 && portalLayoutHeight > 0;
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

                    const portalRootWindowRect = await measureInWindow(portalRootNode);
                    if (portalRootWindowRect) {
                        const deltaRect: WindowRect = {
                            x: anchorRectFromProp.x - portalRootWindowRect.x,
                            y: anchorRectFromProp.y - portalRootWindowRect.y,
                            width: anchorRectFromProp.width,
                            height: anchorRectFromProp.height,
                        };
                        if (withinPortalLayout(deltaRect)) {
                            anchorRect = deltaRect;
                        } else if (withinPortalLayout(anchorRectFromProp)) {
                            anchorRect = anchorRectFromProp;
                        } else {
                            anchorRect = deltaRect;
                        }
                    } else {
                        anchorRect = anchorRectFromProp;
                    }
                    anchorIsPortalRelative = true;
                } else {
                    anchorRect = anchorRectFromProp;
                }
            }

            if (!anchorRect && resolvedAnchorMode === 'view' && portalRootNode) {
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

            if (!anchorRect && resolvedAnchorMode === 'view') {
                anchorRect = await measureInWindow(anchorNode);
            }

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
            if ((shouldPortalWeb || shouldPortalNative) && resolvedAnchorMode === 'view' && (anchorRect.width <= 1 || anchorRect.height <= 1)) {
                return false;
            }

            const boundaryRectBase =
                boundaryRectRaw ??
                (portalRootNode && portalTarget?.layout?.width && portalTarget?.layout?.height
                    ? { x: 0, y: 0, width: portalTarget.layout.width, height: portalTarget.layout.height }
                    : getFallbackBoundaryRect({ windowWidth, windowHeight }));

            // Treat the on-screen keyboard, or the floating bottom chrome it rises over, as reducing the usable
            // bottom viewport. Without this, `placement="auto"` can flip a menu into the covered region, making
            // it look like the popover disappeared, and a tall panel runs under the tab bar.
            // A popover opened from inside that chrome (the docked composer's chips) is not bounded by it: the
            // chrome stops at its anchor's own bottom edge, so the box ends where its room was measured to (native QA:
            // a top-placed engine picker was otherwise pinned 101 pt above its chip, into the status bar). An anchor
            // the keyboard covers still keeps the keyboard's bound.
            const boundaryBottom = boundaryRectBase.y + boundaryRectBase.height;
            const anchorBottom = anchorRect.y + anchorRect.height;
            const chromeOcclusion = anchorBottom > boundaryBottom - bottomChromeClearance
                ? Math.max(0, boundaryBottom - anchorBottom)
                : bottomChromeClearance;
            const bottomOcclusion = Math.max(keyboardHeight, chromeOcclusion);
            const unoccludedBoundary: WindowRect = {
                ...boundaryRectBase,
                height: Math.max(0, boundaryRectBase.height - bottomOcclusion),
            };
            // A native portal root can reach past the screen (a paged pane's row of pages, a pane sliding away) and
            // under the status bar: the popover stays on the part the screen shows, below the top safe area. A phone
            // panel spans its boundary from the boundary's edge, so a root edge off the screen placed it out of
            // sight with its backdrop live (SESSION-PHONE 21:50). A root the screen does not show leaves no room:
            // the popover stays unplaced (and inert) rather than open where nobody can see it.
            // A boundary measured in window space (web, or native without a portal root) gets the same rule: a
            // boundary reaching past a short window gave the docked composer's engine picker its 420 cap as room,
            // and its option rail started above the window (QA-B3 r173, web 1280×577).
            const portalRootWindowRect = portalRootNode ? await measureInWindow(portalRootNode) : null;
            if (!isMountedRef.current) return false;
            const boundaryRect: WindowRect = (() => {
                const screenOrigin = portalRootNode ? portalRootWindowRect : { x: 0, y: 0 };
                if (!screenOrigin) return unoccludedBoundary;
                const screenTop = safeAreaTop - screenOrigin.y;
                const screenLeft = -screenOrigin.x;
                const left = Math.max(unoccludedBoundary.x, screenLeft);
                const top = Math.max(unoccludedBoundary.y, screenTop);
                const right = Math.min(unoccludedBoundary.x + unoccludedBoundary.width, screenLeft + windowWidth);
                const bottom = Math.min(unoccludedBoundary.y + unoccludedBoundary.height, screenTop - safeAreaTop + windowHeight);
                return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
            })();

            if (closeForHiddenAnchor && (
                anchorRect.x + anchorRect.width <= boundaryRect.x
                || anchorRect.x >= boundaryRect.x + boundaryRect.width
                || anchorRect.y + anchorRect.height <= boundaryRect.y
                || anchorRect.y >= boundaryRect.y + boundaryRect.height
            )) {
                closeForHiddenAnchor();
                return true;
            }

            // Shrink the usable boundary so the popover doesn't sit flush to the container edges.
            // (This also makes maxHeight/maxWidth clamping respect the margin.)
            let effectiveBoundaryRect: WindowRect = {
                x: boundaryRect.x + edgeInsets.horizontal,
                y: boundaryRect.y + edgeInsets.top,
                width: Math.max(0, boundaryRect.width - edgeInsets.horizontal * 2),
                height: Math.max(0, boundaryRect.height - edgeInsets.top - edgeInsets.bottom),
            };

            const horizontalBoundaryNode = props.horizontalBoundaryRef?.current ?? null;
            if (horizontalBoundaryNode) {
                // Same carry as the clearance below: window-space rects, moved into the anchor's space.
                const [horizontalWindowRect, anchorWindowRect] = await Promise.all([
                    measureInWindow(horizontalBoundaryNode),
                    resolvedAnchorMode === 'rect' ? Promise.resolve(anchorRectFromProp) : measureInWindow(anchorNode),
                ]);
                if (!isMountedRef.current) return false;
                if (horizontalWindowRect && anchorWindowRect) {
                    const left = Math.max(effectiveBoundaryRect.x, horizontalWindowRect.x + (anchorRect.x - anchorWindowRect.x));
                    const right = Math.min(
                        effectiveBoundaryRect.x + effectiveBoundaryRect.width,
                        horizontalWindowRect.x + horizontalWindowRect.width + (anchorRect.x - anchorWindowRect.x),
                    );
                    // A view the anchor does not sit inside gives no usable width: the window keeps it.
                    if (right - left >= 1 && anchorRect.x >= left && anchorRect.x <= right) {
                        effectiveBoundaryRect = { ...effectiveBoundaryRect, x: left, width: right - left };
                    }
                }
            }

            const clearanceNode = props.clearanceRef?.current ?? null;
            if (clearanceNode) {
                // Measured in window space and carried into the anchor's space by the anchor's own window
                // offset, so a portal-relative anchor and a window-relative clearance never mix.
                const [clearanceWindowRect, anchorWindowRect] = await Promise.all([
                    measureInWindow(clearanceNode),
                    resolvedAnchorMode === 'rect' ? Promise.resolve(anchorRectFromProp) : measureInWindow(anchorNode),
                ]);
                if (!isMountedRef.current) return false;
                if (clearanceWindowRect && anchorWindowRect) {
                    // The clearance alone sets the vertical extent: a caret anchor's rect can trail a
                    // reflow by a frame, and only the live clearance says where the composer is now.
                    const top = clearanceWindowRect.y + (anchorRect.y - anchorWindowRect.y);
                    const bottom = top + clearanceWindowRect.height;
                    const roomBeyond = Math.max(
                        top - effectiveBoundaryRect.y,
                        effectiveBoundaryRect.y + effectiveBoundaryRect.height - bottom,
                    ) - gap;
                    // A clearance view that fills the boundary leaves no side to open on: hang from the anchor.
                    if (roomBeyond >= 1) {
                        anchorRect = { ...anchorRect, y: top, height: bottom - top };
                    }
                }
            }

            const availableTop = (anchorRect.y - effectiveBoundaryRect.y) - gap;
            const availableBottom = (effectiveBoundaryRect.y + effectiveBoundaryRect.height - (anchorRect.y + anchorRect.height)) - gap;
            const availableLeft = (anchorRect.x - effectiveBoundaryRect.x) - gap;
            const availableRight = (effectiveBoundaryRect.x + effectiveBoundaryRect.width - (anchorRect.x + anchorRect.width)) - gap;

            const resolvedPlacement = resolveHappierPopoverPlacement({
                placement,
                preferredMinAvailable: placement === 'auto-horizontal' || placement === 'left' || placement === 'right'
                    ? maxWidthCap
                    : (props.placementMinSpace ?? preferredRoom),
                flip: props.flip !== false,
                available: {
                    top: availableTop,
                    bottom: availableBottom,
                    left: availableLeft,
                    right: availableRight,
                },
            });

            // A designed panel that fits on neither side keeps its size and slides inside the boundary;
            // the bottom placement's clamp then lifts it until it ends at the boundary's bottom edge. A phone
            // panel never covers its trigger (R2): it takes the side with more room and scrolls inside it.
            const shiftsToFit = props.fit === 'shift'
                && !spansPhone
                && (resolvedPlacement === 'top' || resolvedPlacement === 'bottom')
                && Math.max(availableTop, availableBottom) < preferredRoom;
            const placementUsed = shiftsToFit ? 'bottom' : resolvedPlacement;
            const maxHeightAvailable = shiftsToFit
                ? effectiveBoundaryRect.height
                : resolvedPlacement === 'bottom'
                    ? availableBottom
                    : resolvedPlacement === 'top'
                        ? availableTop
                        : resolvePopoverSideMaxHeight({
                            anchorY: anchorRect.y,
                            anchorAlignVertical: anchorAlignVerticalOnPortal,
                            boundaryY: effectiveBoundaryRect.y,
                            boundaryHeight: effectiveBoundaryRect.height,
                            gap,
                            preferredMinHeight: Math.min(maxHeightCap, props.placementMinSpace ?? preferredRoom),
                        });

            const maxWidthAvailable =
                resolvedPlacement === 'right'
                    ? availableRight
                    : resolvedPlacement === 'left'
                        ? availableLeft
                        : (
                            // Shifted panels use the room inside the boundary's edge padding. Their vertical
                            // anchor gap must not shrink that width: a shell switching to boundary layout
                            // when cramped would otherwise gain width, switch back, and repeat forever.
                            (topBottomLayoutOnPortal === 'boundary' || sizesToAnchorExplicitly || props.fit === 'shift')
                            && (resolvedPlacement === 'top' || resolvedPlacement === 'bottom')
                                ? effectiveBoundaryRect.width
                                : effectiveBoundaryRect.width - gap * 2
                        );

            const nextMaxHeight = Math.max(0, Math.min(maxHeightCap, Math.floor(maxHeightAvailable)));
            const nextMaxWidth = Math.max(0, Math.min(maxWidthCap, Math.floor(maxWidthAvailable)));
            // Treat "no available space" as an invalid transient measurement. On native (especially Android),
            // early measurements can occasionally report temporary boundary/anchor geometry that would yield
            // maxHeight/maxWidth = 0, which makes popovers appear collapsed. Retrying a couple frames later
            // avoids getting stuck at 0-height.
            if (nextMaxHeight < 1 || nextMaxWidth < 1) {
                return false;
            }

            const nextComputed: PopoverLayoutProps = {
                placement: placementUsed,
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
                let didRun = false;
                let fallbackTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                    fallbackTimer = null;
                    if (didRun) return;
                    didRun = true;
                    cb();
                }, 50);
                requestAnimationFrame(() => {
                    if (fallbackTimer !== null) {
                        clearTimeout(fallbackTimer);
                        fallbackTimer = null;
                    }
                    if (didRun) return;
                    didRun = true;
                    cb();
                });
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

        if (Platform.OS === 'web') {
            void measureWithRetries(0);
        } else {
            scheduleFrame(() => { void measureWithRetries(0); });
        }
    }, [anchorAlignVerticalOnPortal, anchorRef, anchorRectFromProp, bottomChromeClearance, boundaryRef, closeForHiddenAnchor, edgeInsets.horizontal, edgeInsets.top, edgeInsets.bottom, gap, keyboardBottomInsetProp, maxHeightCap, maxWidthCap, open, preferredRoom, placement, props.clearanceRef, props.horizontalBoundaryRef, props.fit, props.flip, spansPhone, safeAreaTop, props.placementMinSpace, resolvedAnchorMode, shouldPortalNative, shouldPortalWeb, topBottomLayoutOnPortal, sizesToAnchorExplicitly, windowHeight, windowWidth, portalTarget]);

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
        const visualViewport = window.visualViewport;
        visualViewport?.addEventListener('resize', schedule);

        // Focus and responsive reflow can move an anchor without scrolling or
        // resizing the layout viewport. Track those changes through the same scheduler.
        const anchorEl = resolvedAnchorMode === 'view' ? getDomElementFromNode(anchorRef.current) : null;
        const scheduleFocusLayout = (event: FocusEvent) => {
            if (!(event.target instanceof Node)) return;
            if (anchorEl?.contains(event.target) || getContentDomElement()?.contains(event.target)) schedule();
        };
        window.addEventListener('focusin', scheduleFocusLayout);
        // The clearance view sets the vertical extent, so its reflow (an ancestor settling after a
        // window resize moves it without resizing it) re-places the popover like the anchor's does.
        const clearanceEl = getDomElementFromNode(props.clearanceRef?.current ?? null);
        const horizontalBoundaryEl = getDomElementFromNode(props.horizontalBoundaryRef?.current ?? null);
        const anchorLayoutObserver = (anchorEl || clearanceEl || horizontalBoundaryEl) && typeof ResizeObserver === 'function'
            ? new ResizeObserver(schedule)
            : null;
        for (const start of [anchorEl, clearanceEl, horizontalBoundaryEl]) {
            for (let element: HTMLElement | null = start; element && anchorLayoutObserver; element = element.parentElement) {
                anchorLayoutObserver.observe(element);
            }
        }

        // A portal escapes the anchor's scrolling ancestors (a page, a pane, the zero-height modal-aware host of an
        // embedded composer), so it follows whichever of them scrolls the anchor, whatever its boundary or scroll
        // source: WF-ACCEPT-1119 item 2, where a body portal bounded by a non-scrolling view stayed at y 488 while the
        // page scrolled its "…" up 85 px. Element scroll events do not bubble: capture them, and keep the ones that
        // move the anchor. Each frame of a scroll re-places it once, so it moves with the anchor rather than after it.
        let scrollFrame: number | null = null;
        const scheduleScrollFrame = () => {
            if (scrollFrame !== null) return;
            scrollFrame = window.requestAnimationFrame(() => {
                scrollFrame = null;
                recompute();
            });
        };
        const scheduleAncestorScroll = (event: Event) => {
            const anchorEl = getDomElementFromNode(anchorRef.current);
            if (event.target === window || (event.target instanceof Node && anchorEl && event.target.contains(anchorEl))) {
                scheduleScrollFrame();
            }
        };
        if (shouldPortalWeb) {
            window.addEventListener('scroll', scheduleAncestorScroll, { capture: true, passive: true });
        }
        // An explicit scroll source that does not hold the anchor (an inner list) still re-places the popover.
        const scrollSourceEl = shouldPortalWeb ? getScrollSourceDomElement() : null;
        if (scrollSourceEl) {
            scrollSourceEl.addEventListener('scroll', scheduleScrollFrame, { passive: true } as any);
        }
        return () => {
            if (timer !== null) window.clearTimeout(timer);
            if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
            window.removeEventListener('resize', schedule);
            visualViewport?.removeEventListener('resize', schedule);
            window.removeEventListener('focusin', scheduleFocusLayout);
            anchorLayoutObserver?.disconnect();
            if (shouldPortalWeb) {
                window.removeEventListener('scroll', scheduleAncestorScroll, true);
            }
            if (scrollSourceEl) {
                scrollSourceEl.removeEventListener('scroll', scheduleScrollFrame as any);
            }
        };
    }, [anchorRef, getContentDomElement, getDomElementFromNode, getScrollSourceDomElement, open, props.clearanceRef, props.horizontalBoundaryRef, recompute, resolvedAnchorMode, shouldPortalWeb]);

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
        // A keyboard already up when this opens sends no event (the docked Search types before its chooser opens):
        // start from its current frame, and from none when it is down.
        if (typeof keyboard.isVisible === 'function') {
            const height = keyboard.isVisible() ? getKeyboardHeightFromEvent({ endCoordinates: keyboard.metrics?.() }) : 0;
            if (height !== null && height !== keyboardHeightRef.current) {
                keyboardHeightRef.current = height;
                schedule();
            }
        }

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
                    if (topBottomLayoutOnPortal === 'boundary') {
                        return Math.min(computed.maxWidth, Math.floor(boundaryRect.width));
                    }
                    return matchAnchorWidthOnPortal
                        ? Math.min(computed.maxWidth, Math.max(Math.floor(anchorRectState.width), props.portal?.anchoredMinWidth ?? 0))
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
                if (topBottomLayoutOnPortal === 'boundary') {
                    return boundaryRect.x;
                }
                const desiredLeftRaw = (() => {
                    const anchorRight = anchorRectState.x + anchorRectState.width;
                    // The box carries its horizontal edge padding as a transparent gutter: an edge-hung popover
                    // places its visible surface, not that gutter, on the anchor's edge (WF-ACCEPT-1118 item 1).
                    const gutter = horizontalGutter;
                    const startLeft = anchorRectState.x - gutter;
                    const endLeft = anchorRight - desiredWidth + gutter;
                    // A popover hangs from its requested edge while that edge leaves it its full width; an
                    // anchor near the other window edge hangs it from that edge instead, so it stays attached
                    // to its trigger rather than sliding away from it to fit.
                    // Fit is the visible surface's: the gutter may overhang the boundary, as the clamp below allows.
                    const startFits = startLeft + desiredWidth - gutter <= boundaryRect.x + boundaryRect.width;
                    const endFits = endLeft + gutter >= boundaryRect.x;
                    switch (resolvePopoverAnchorEdge(anchorAlignOnPortal, anchorRectState, boundaryRect)) {
                        case 'end':
                            return endFits || !startFits ? endLeft : startLeft;
                        case 'center':
                            return anchorRectState.x + (anchorRectState.width - desiredWidth) / 2;
                        case 'start':
                        default:
                            return startFits || !endFits ? startLeft : endLeft;
                    }
                })();
                return desiredLeftRaw;
            })();

            const top = (() => {
                if (computed.placement === 'left' || computed.placement === 'right') {
                    const contentHeight = measuredSurfaceHeight ?? computed.maxHeight;
                    const desiredTopRaw = (() => {
                        switch (anchorAlignVerticalOnPortal) {
                            case 'end':
                                return anchorRectState.y + anchorRectState.height - contentHeight;
                            case 'start':
                                return anchorRectState.y - sideVerticalGutter;
                            case 'center':
                            default:
                                return anchorRectState.y + (anchorRectState.height - contentHeight) / 2;
                        }
                    })();

                    const settled = settledSideTopRef.current;
                    // A submenu (start-aligned) stands at its row whenever its measured content fits below it: a tall
                    // placeholder that lifted it never keeps it over the page above once the content is short (BC-D5 N2).
                    // Its transparent bottom gutter may overhang the boundary, as the horizontal clamp lets a side gutter.
                    const startFitsBelow = anchorAlignVerticalOnPortal === 'start' && measuredSurfaceHeight !== null
                        && desiredTopRaw + contentHeight - sideVerticalGutter <= boundaryRect.y + boundaryRect.height;
                    const heldTopRaw = !startFitsBelow && settled !== null && settled.placement === computed.placement
                        ? anchorRectState.y + settled.offset
                        : desiredTopRaw;
                    const fittedTop = startFitsBelow ? desiredTopRaw : Math.min(
                        boundaryRect.y + boundaryRect.height - contentHeight,
                        Math.max(boundaryRect.y, heldTopRaw),
                    );
                    // Settle once the content has a measured height (until then the box is hidden).
                    if ((startFitsBelow || settled === null || settled.placement !== computed.placement) && contentRectState !== null && contentRectState.height > 0) {
                        settledSideTopRef.current = { placement: computed.placement, offset: fittedTop - anchorRectState.y };
                    }
                    return fittedTop;
                }

                // top/bottom
                const contentHeight = measuredSurfaceHeight ?? computed.maxHeight;
                const topForBottom = Math.min(
                    boundaryRect.y + boundaryRect.height - (props.fit === 'shift' ? contentHeight : belowSurfaceHeight ?? computed.maxHeight),
                    Math.max(boundaryRect.y, anchorRectState.y + anchorRectState.height + gap),
                );
                const topForTop = Math.max(
                    boundaryRect.y,
                    Math.min(boundaryRect.y + boundaryRect.height - contentHeight, anchorRectState.y - contentHeight - gap),
                );
                if (shownPlacement === 'top' && props.fit === 'shift') {
                    const settled = settledSideTopRef.current;
                    const heldTopRaw = settled !== null && settled.placement === 'top' ? anchorRectState.y + settled.offset : topForTop;
                    const fittedTop = Math.min(
                        boundaryRect.y + boundaryRect.height - contentHeight,
                        Math.max(boundaryRect.y, heldTopRaw),
                    );
                    if ((settled === null || settled.placement !== 'top') && contentRectState !== null && contentRectState.height > 0) {
                        settledSideTopRef.current = { placement: 'top', offset: fittedTop - anchorRectState.y };
                    }
                    return fittedTop;
                }
                return shownPlacement === 'top' ? topForTop : topForBottom;
            })();

            // The box carries the edge padding as a transparent gutter, so the box may reach the boundary's
            // outer edge: the visible surface then stands exactly the edge margin from it, not twice.
            const clampedLeft = Math.min(
                boundaryRect.x + boundaryRect.width + horizontalGutter - desiredWidth,
                Math.max(boundaryRect.x - horizontalGutter, left),
            );

            const verticalStyle: ViewStyle = (() => {
                // Prefer anchoring the edge closest to the anchor so the popover doesn’t “jiggle”
                // when its content height changes after opening (e.g. async-loaded trees/lists).
                //
                // For top-placed portals we can pin the bottom edge to (anchorTop - gap) using `bottom`,
                // which avoids depending on the measured content height for vertical positioning. A designed
                // panel (`fit: 'shift'`) keeps its settled top instead (`settledSideTopRef`).
                if (shownPlacement === 'top' && props.fit !== 'shift') {
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
                    // The box never starts above the boundary: a trigger that has scrolled up while the panel
                    // still stands at its last measured size would otherwise carry it out of the window.
                    const panelHeight = measuredSurfaceHeight ?? computed.maxHeight;
                    const boundaryTopInPortalSpace =
                        position === 'absolute'
                            ? boundaryRect.y - webPortalOffsetY
                            : boundaryRect.y;
                    const pinnedBottomEdge = Math.min(
                        boundaryBottomInPortalSpace,
                        Math.max(
                            anchorTopInPortalSpace - gap,
                            boundaryTopInPortalSpace + panelHeight,
                        ),
                    );
                    return {
                        bottom: Math.floor(portalHeight - pinnedBottomEdge - nativePortalShadowOutset),
                    } as any;
                }

                return {
                    top: Math.floor(top - (position === 'absolute' ? webPortalOffsetY : 0) - nativePortalShadowOutset),
                } as any;
            })();

            if (sizeToContentOnPortal) {
                // The content decides the width within its bounds. An edge-aligned popover pins
                // one edge, so it needs no measurement of the content width; a centred one (a
                // tooltip) is placed from that measurement and clamped inside the boundary, and
                // stays hidden until the measurement exists (`portalOpacity`).
                const anchorRight = anchorRectState.x + anchorRectState.width;
                const vertical = computed.placement === 'top' || computed.placement === 'bottom';
                // An edge-aligned popover hangs from its requested edge while that edge leaves it its
                // full width; a chip near the other window edge opens from its opposite edge instead of
                // being squeezed into the leftover strip.
                const startRoom = boundaryRect.x + boundaryRect.width - anchorRectState.x;
                const endRoom = anchorRight - boundaryRect.x;
                const fullWidth = Math.min(computed.maxWidth, CONTENT_SIZED_POPOVER_WIDTH.maxPx);
                const requestedEnd = resolvePopoverAnchorEdge(anchorAlignOnPortal, anchorRectState, boundaryRect) === 'end';
                const requestedRoom = requestedEnd ? endRoom : startRoom;
                const otherRoom = requestedEnd ? startRoom : endRoom;
                const alignEnd = vertical
                    ? (requestedRoom < fullWidth && otherRoom > requestedRoom ? !requestedEnd : requestedEnd)
                    : computed.placement === 'left';
                const room = !vertical
                    ? computed.maxWidth
                    : centresMeasuredContent
                        ? boundaryRect.width
                        : alignEnd
                            ? endRoom
                            : startRoom;
                const maxWidth = Math.max(0, Math.min(computed.maxWidth, CONTENT_SIZED_POPOVER_WIDTH.maxPx, Math.floor(room)));
                // A content-sized popover that matches its anchor keeps the anchor's width as a floor, never as
                // its width: a narrow trigger does not make a narrow menu, a wide one is not outgrown.
                const minWidth = Math.min(
                    Math.max(0, contentSizedMinWidth, matchAnchorWidthOnPortal ? Math.floor(anchorRectState.width) : 0),
                    maxWidth,
                );
                const offsetX = position === 'absolute' ? webPortalOffsetX : 0;
                const portalWidth = Platform.OS === 'web' && position === 'absolute'
                    ? (webPortalTargetRect?.width ?? windowWidth)
                    : windowWidth;
                const horizontal: ViewStyle = (() => {
                    if (computed.placement === 'left') {
                        return { right: Math.floor(portalWidth - (anchorRectState.x - gap - offsetX) - nativePortalShadowOutset) };
                    }
                    if (computed.placement === 'right') {
                        return { left: Math.floor(anchorRight + gap - offsetX - nativePortalShadowOutset) };
                    }
                    if (centresMeasuredContent) {
                        const measuredWidth = contentRectState
                            ? Math.min(maxWidth, Math.max(minWidth, contentRectState.width - nativePortalShadowOutset * 2))
                            : maxWidth;
                        const centredLeft = anchorRectState.x + (anchorRectState.width - measuredWidth) / 2;
                        const clampedCentredLeft = Math.min(
                            boundaryRect.x + boundaryRect.width - measuredWidth,
                            Math.max(boundaryRect.x, centredLeft),
                        );
                        return { left: Math.round(clampedCentredLeft - offsetX - nativePortalShadowOutset) };
                    }
                    return alignEnd
                        ? { right: Math.floor(portalWidth - (anchorRight - offsetX) - nativePortalShadowOutset) }
                        : { left: Math.floor(Math.max(boundaryRect.x, anchorRectState.x) - offsetX - nativePortalShadowOutset) };
                })();
                return {
                    position,
                    ...horizontal,
                    ...verticalStyle,
                    zIndex: 1000,
                    minWidth: minWidth + (nativePortalShadowOutset * 2),
                    maxWidth: maxWidth + (nativePortalShadowOutset * 2),
                    // A web portal host can be a 0-wide node (inside the sidebar), and an
                    // absolutely positioned box shrinks to fit ITS containing block: the content
                    // would wrap at its longest word. Size to the content's own width instead,
                    // bounded by min/max above.
                    ...(Platform.OS === 'web' ? ({ width: 'max-content' } as unknown as ViewStyle) : null),
                };
            }

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
        if (centresMeasuredContent && (!contentRectState || contentRectState.width < 1)) return 0;
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

    useWebPopoverContentMeasure({
        enabled: Platform.OS === 'web' && open && shouldPortalWeb && anchorRectState !== null,
        getContentElement: getContentDomElement,
        layout: computed,
        publish: setContentRectState,
    });

    const stopScrollEventPropagationOnWeb = React.useCallback((event: any) => {
        // Expo Router (Vaul/Radix) modals on web often install document-level scroll-lock listeners
        // that `preventDefault()` wheel/touch scroll, which breaks scrolling inside portaled popovers.
        // Stopping propagation here keeps the event within the popover subtree so native scrolling works.
        if (Platform.OS !== 'web') return;
        if (!shouldPortalWeb) return;
        if (typeof event?.stopPropagation === 'function') event.stopPropagation();
    }, [shouldPortalWeb]);
    const stopPortaledInteractionPropagationOnWeb = React.useCallback((event: any) => {
        // React events bubble through the logical component tree even when the popover is rendered
        // into a DOM portal. If an option closes and unmounts the portal during the same click,
        // Expo Router's parent modal layer can otherwise receive that click and dismiss the route.
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
            return horizontal > 0 && !spansPhone ? { paddingHorizontal: horizontal } : {};
        }
        if (computed.placement === 'left' || computed.placement === 'right') {
            return vertical > 0 ? { paddingVertical: vertical } : {};
        }
        return {};
    }, [computed.placement, edgePadding, spansPhone]);

    const nativePortalShadowPaddingStyle = React.useMemo<ViewStyle>(() => {
        return addPaddingOutset([paddingStyle, containerStyle], nativePortalShadowOutset);
    }, [containerStyle, nativePortalShadowOutset, paddingStyle]);
    const contentContainerMaxWidth = computed.maxWidth + (nativePortalShadowOutset * 2);

    // Body-level floating surfaces sit below dialogs, except one opened from inside a dialog, which
    // stacks just above that dialog's layer; modal-local portals inherit their layer.
    const layerZ = props.layer === 'hoverCard' ? HOVER_CARD_PORTAL_Z_INDEX : POPOVER_PORTAL_Z_INDEX;
    const portalZ = portalTargetOnWeb === 'body' && modalLayerZIndex !== null
        ? Math.max(layerZ, modalLayerZIndex + 1)
        : layerZ;

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
    const backdropSpotlight = typeof backdrop === 'object' && backdrop ? (backdrop.spotlight ?? false) : false;
    const backdropAnchorOverlay = typeof backdrop === 'object' && backdrop ? backdrop.anchorOverlay : undefined;
    const backdropStyle = typeof backdrop === 'object' && backdrop ? backdrop.style : undefined;
    const closeOnBackdropPan = typeof backdrop === 'object' && backdrop ? (backdrop.closeOnPan ?? false) : false;
    const backdropPointerEventsEnabled =
        !overlayPresence.exiting
        && (!(shouldPortalWeb || shouldPortalNative) || portalOpacity !== 0);
    const contentPointerEvents = resolveOverlayPointerEvents(
        props.passive || overlayPresence.exiting || ((shouldPortalWeb || shouldPortalNative) && portalOpacity === 0)
            ? 'none'
            // On native the container also holds the transparent shadow outset around the surface: it passes touches
            // through, so a panel opened just under a header never swallows that header's taps (native QA: Session ⋯
            // on the Companion tab). The surface inside still takes them.
            : Platform.OS === 'web' ? 'auto' : 'box-none',
    );

    const escapeLayer = useEscapeLayer({
        enabled: Platform.OS === 'web' && open && typeof onRequestClose === 'function',
        priority: ESCAPE_LAYER_PRIORITIES.popover,
        allowEditableTarget: true,
        onEscape: () => {
            requestClose('escape');
            return true;
        },
    });

    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        if (!open) return;
        if (!onRequestClose) return;
        if (typeof document === 'undefined') return;

        const shouldAttachPointerDownCapture = !(backdropEnabled && backdropBlocksOutsidePointerEvents);
        const openEntry: OpenWebPopoverEntry = {
            getContentElement: getContentDomElement,
            getInteractionBoundaryElement: () => getDomElementFromNode(props.interactionBoundaryRef?.current),
            getAnchorElement: () => getDomElementFromNode(anchorRef.current),
        };
        OPEN_WEB_POPOVERS.push(openEntry);
        const handlePointerDownCapture = (event: Event) => {
            const target = event.target as Node | null;
            if (!target) return;
            const contentEl = getContentDomElement();
            if (contentEl && contentEl.contains(target)) return;
            // Global dialogs render at their provider, outside the opening popover's
            // React/DOM subtree. Their presses belong to that higher modal layer.
            // A menu inside this dialog still handles presses outside its own content.
            const modalLayer = target instanceof Element ? target.closest('[data-happy-modal-layer]') : target.parentElement?.closest('[data-happy-modal-layer]');
            if (modalLayer && contentEl && !modalLayer.contains(contentEl)) return;
            // A popover opened from inside this one (a row's menu in a roster) handles this press itself.
            if (hasOpenNestedWebPopover(openEntry)) return;
            const anchorEl = getDomElementFromNode(anchorRef.current);
            // If we cannot resolve the DOM elements (common with RN-web refs in portaled subtrees),
            // fail open: do not swallow the click. This avoids breaking in-popover interactions.
            if (!contentEl && !anchorEl) return;
            if (anchorEl && anchorEl.contains(target)) {
                if (props.closeOnAnchorPress) {
                    requestClose('dismiss');
                }
                return;
            }

            const interactionBoundary = getDomElementFromNode(props.interactionBoundaryRef?.current);
            if (interactionBoundary?.contains(target)) return;
            const shouldConsumeOutsidePointerDown = props.consumeOutsidePointerDown ?? true;
            if (shouldConsumeOutsidePointerDown) {
                // Prevent nested Radix/Vaul "outside click" logic from also dismissing the underlying modal.
                event.stopPropagation();
                event.stopImmediatePropagation();
                // A finger that taps beside an open menu only closes it, as on every phone: the row or
                // link under the tap never receives the click that follows.
                const pointerType = (event as PointerEvent).pointerType;
                if (pointerType === 'touch' || pointerType === 'pen') swallowNextClick();
                requestClose('dismiss');
                return;
            }

            // On web, allow the outside click to be handled by its actual target (for example: another
            // chip trigger). Close the popover in the next task to avoid interfering with the click.
            setTimeout(() => requestClose('dismiss'), 0);
        };

        if (shouldAttachPointerDownCapture) {
            document.addEventListener('pointerdown', handlePointerDownCapture, true);
        }
        return () => {
            const index = OPEN_WEB_POPOVERS.indexOf(openEntry);
            if (index >= 0) OPEN_WEB_POPOVERS.splice(index, 1);
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
        props.interactionBoundaryRef,
        requestClose,
    ]);

    // A repeated native geometry measurement can revisit this component without changing
    // the public layout. Keep the content render tied to that layout, not the measurement.
    // The popover is a floating layer opened over its anchor's surface, never in that surface's flow.
    // On a phone the popover spans the screen, so a submenu opened inside it pushes in place (`AnchoredPhonePushHost`).
    const renderedChildren = React.useMemo(() => {
        const renderProps = { ...computed, maxWidth: contentMaxWidth, requestClose, ...(phone ? { pushesSubmenus: true } : {}) };
        const body = renderBody({ renderProps, isolation: shouldPortalWeb ? 'portal' : 'none' });
        return <GlassOpenedLayer>
            <FloatingOverlayPhonePanelContext.Provider value={spansPhone}>
                {phone ? <AnchoredPhonePushHost renderProps={renderProps}>{body}</AnchoredPhonePushHost> : body}
            </FloatingOverlayPhonePanelContext.Provider>
        </GlassOpenedLayer>;
    }, [renderBody, computed, contentMaxWidth, phone, spansPhone, requestClose, shouldPortalWeb]);
    const content = (
        <EscapeLayerProvider layer={escapeLayer}>
            <PopoverBackdrop
                backdrop={backdropEnabled ? backdrop : false}
                backdropBlocksOutsidePointerEvents={backdropBlocksOutsidePointerEvents}
                backdropOutsidePointerEventsMode={backdropOutsidePointerEventsMode}
                backdropPointerEventsEnabled={backdropPointerEventsEnabled}
                backdropEffect={backdropEffect}
                backdropSpotlight={backdropSpotlight}
                backdropAnchorOverlay={backdropAnchorOverlay}
                backdropStyle={backdropStyle}
                closeOnBackdropPan={closeOnBackdropPan}
                onRequestClose={() => requestClose('dismiss')}
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
                focusable={Platform.OS !== 'web' && autoFocusOnOpen}
                {...(shouldPortalWeb
                    ? ({
                        onClick: stopPortaledInteractionPropagationOnWeb,
                        onPointerDown: stopPortaledInteractionPropagationOnWeb,
                        onTouchStart: stopPortaledInteractionPropagationOnWeb,
                        onWheel: stopScrollEventPropagationOnWeb,
                        onTouchMove: stopScrollEventPropagationOnWeb,
                    } as any)
                    : {})}
                {...(Platform.OS === 'web' && shouldPortalWeb
                    ? ({ nativeID: portalIdRef.current, testID: portalIdRef.current } as any)
                    : {})}
                style={[
                    placementStyle,
                    paddingStyle,
                    containerStyle,
                    nativePortalShadowPaddingStyle,
                    // A content-sized popover carries its own (narrower) bounds in `placementStyle`.
                    typeof placementStyle.maxWidth === 'number' ? null : { maxWidth: contentContainerMaxWidth },
                    shouldPortalWeb ? { opacity: portalOpacity }
                        // A native popover waits for its placement offscreen, never by opacity: UIKit renders no
                        // glass created under an ancestor with alpha below 1 (iOS 26 QA: a root popover stayed clear).
                        : shouldPortalNative && portalOpacity === 0 ? NATIVE_UNPLACED_STYLE : null,
                    shouldPortal ? { zIndex: portalZ + 1 } : null,
                    // The legacy prop used to take precedence over caller-owned styles.
                    contentPointerEvents.webStyle,
                ]}
                pointerEvents={contentPointerEvents.nativePointerEvents}
                onLayout={(e) => {
                    // Used to improve portal alignment (especially left/right centering)
                    const layout = e?.nativeEvent?.layout;
                    if (!layout) return;
                    const next = { x: 0, y: 0, width: layout.width ?? 0, height: layout.height ?? 0 };
                    // Avoid rerender loops from tiny float changes
                    if (Platform.OS !== 'web' || !shouldPortalWeb) {
                        setContentRectState((prev) => {
                            if (!prev) return next;
                            if (Math.abs(prev.width - next.width) > 1 || Math.abs(prev.height - next.height) > 1) {
                                return next;
                            }
                            return prev;
                        });
                    }

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
                                disabled={portalOpacity === 0}
                                kind="popover"
                                direction={popoverMotionDirection}
                                // Placed above its anchor, the content hangs from the box's bottom edge (native QA r3n).
                                style={shownPlacement === 'top' ? TOP_PLACED_CONTENT_STYLE : undefined}
                                {...(props.passive ? { pointerEvents: 'none' as const } : {})}
                            >
                                {renderedChildren}
                            </OverlayMotionFrame>
                        </ModalPortalTargetProvider>
                    </>
                ) : (
                    <OverlayMotionFrame
                        visible={motionVisible}
                        disabled={portalOpacity === 0}
                        kind="popover"
                        direction={popoverMotionDirection}
                        style={shownPlacement === 'top' ? TOP_PLACED_CONTENT_STYLE : undefined}
                        // A popover's content stands on floating glass: native moves it by transform alone.
                        material
                        {...(props.passive ? { pointerEvents: 'none' as const } : {})}
                    >
                        {renderedChildren}
                    </OverlayMotionFrame>
                )}
            </ViewWithWheel>
        </EscapeLayerProvider>
    );

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
        content: overLivePicture && content
            ? <GlassLivePictureBackdropContext.Provider value>{content}</GlassLivePictureBackdropContext.Provider>
            : content,
    });

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
