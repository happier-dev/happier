import * as React from 'react';
import { Platform, StyleSheet as RNStyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { WidgetPresentationProvider, useWidgetPresentation, type WidgetPresentation as WidgetBodyPresentation } from '@happier-dev/plugin-ui';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HappierPressable,
    HappierScrollArea,
    HappierWidgetFrame,
    HAPPIER_WIDGET_FRAME_METRICS,
    happierPageTextMetrics,
    resolveHappierWidgetFrameInsetPx,
    type HappierSceneInput,
    type HappierWidgetFrameSourceBinding,
    type HappierWidgetFrameSourceDescriptor,
    type HappierWidgetFrameAnatomy,
    type HappierWidgetFramePlacement,
    type HappierWidgetFrameStyle,
    type HappierWidgetFrameTextRender,
    type HappierLayoutChangeEvent,
    type HappierControlledDisclosure,
    type HappierDisclosureMotionDriver,
} from '@happier-dev/plugin-ui/presentation';

import { resolveThemeCardChromeStyle, resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { renderThemeMaterialSurface } from '@/components/ui/glass/GlassSurface';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { reanimatedDisclosureMotion } from '@/components/ui/lists/ExpandableItem';
import { SurfaceFreshnessLine, SurfaceFreshnessOnSheetProvider } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard, SurfaceStateContentContext, type SurfaceStateAction, type SurfaceStateContentReport } from '@/components/ui/surfaces/SurfaceStateCard';
import { projectWidgetGroupCellContent } from '@happier-dev/plugin-ui/components';
import { SurfaceStateSizeProvider, useSurfaceStateCardSize } from '@/components/ui/surfaces/surfaceStateSize';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ItemRowActionsTitleContext } from '@/components/ui/lists/ItemRowActions';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useHoverCapablePrimaryPointer } from '@/utils/platform/webMobileHeuristics';
import { MiddleEllipsisText } from '@/components/ui/text/MiddleEllipsisText';
import { isWidgetResourceQuietRefresh, WidgetFrameResourceActivityContext } from './widgetFrameResourceActivity';
import { useWidgetBodyRowHeight, WidgetFrameBodyRowsContext, widgetFootprintBodyRows } from './widgetFrameBody';
import { WidgetFrameLoadingBody } from './WidgetFrameLoadingBody';
import { WidgetFrameBodyOpenContext, type WidgetFrameBodyOpen } from './widgetFrameBodyCaption';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { resolveVerticalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';

export type WidgetFrameStyle = HappierWidgetFrameStyle;
export type WidgetFramePlacement = HappierWidgetFramePlacement;

/** How many rows a Home widget's body keeps room for, whatever state it is in. */
export const HOME_WIDGET_BODY_ROWS = 4;

/**
 * What the body shows. `content` is the widget's own rows (a built-in's, a Board item's renderer, or
 * a plugin surface that draws its own states); the other three are the host's W1 states for a widget
 * whose data the host reads.
 */
export type WidgetFrameBody =
    | Readonly<{ kind: 'content'; children: React.ReactNode }>
    /** First load only: a widget with last-known rows shows them while it refreshes. */
    | Readonly<{ kind: 'loading'; accessibilityLabel: string }>
    | Readonly<{ kind: 'empty'; title: string; reason: string; iconName?: IconName; action?: SurfaceStateAction;
        /** The Daybreak scene (A5) drawn in the glyph's place where the centred state has room for it. */
        scene?: HappierSceneInput }>
    | Readonly<{
        kind: 'error';
        /**
         * How bad it is, in the shared state vocabulary: a failure (`error`, the default), something to come back to
         * (`warning`: offline, retrying), or something this viewer can't use (`unavailable`: access gone, unsupported).
         */
        tone?: 'error' | 'warning' | 'unavailable';
        title: string;
        reason: string;
        action?: SurfaceStateAction;
        /** Machine code, behind the state's quiet Details disclosure; never the headline. */
        diagnosticCode?: string | null;
        iconName?: IconName;
    }>;

/**
 * The one footer row: where the widget leads, or — while last-known rows are shown after a failed
 * refresh, or after a change to this card was refused — why it is not as expected, with Retry.
 */
export type WidgetFrameFooter =
    | Readonly<{ kind: 'open'; label: string; onPress: () => void;
        secondary?: Readonly<{ label: string; onPress: () => void }> }>
    | Readonly<{ kind: 'refreshFailed'; reason: string; onRetry?: () => void | Promise<unknown> }>
    /** A change to this card waits for someone's approval. */
    | Readonly<{ kind: 'pending'; reason: string }>;

export type WidgetFrameProps = Readonly<{
    testID: string;
    /** Open independently of the frame's native body/menu controls. */
    onOpen?: () => void;
    /** Existing host target retaining its ref, keyboard and drag semantics. */
    openTarget?: React.ReactNode;
    /** Quiet domain facts, without a divided footer band. */
    facts?: React.ReactNode;
    /** Reuse the native body/footer inside a configured instance's existing frame. */
    presentation?: 'frame' | 'body';
    /** Card (its own surface) or plain (on the page, a hairline above). See `useWidgetFrameStyle`. */
    frameStyle: WidgetFrameStyle;
    placement: WidgetFramePlacement;
    /** A card's anatomy: a glance's one identity line (default), or a Collection item's stacked card. */
    anatomy?: HappierWidgetFrameAnatomy;
    /** The source's mark: its glyph, or a brand mark element. */
    mark?: IconName | React.ReactElement;
    /**
     * A string, or an element the placement owns (the Board's rename field). `null` with no mark, meta
     * or menu draws no header row (an untitled widget group: exactly the footprint of what it holds).
     */
    title: string | React.ReactElement | null;
    /** The source's name, quiet beside the title ("Note", a plugin's name), or the placement's own source text. */
    source?: string | React.ReactElement | HappierWidgetFrameSourceDescriptor;
    /** Freshness ("As of 10:42") or a count, only when the source actually knows it. */
    meta?: React.ReactNode;
    /**
     * A live fact that belongs to the title itself (a running call's clock), set right after it. The title
     * line is then full, so the source reads on its own line beneath (lab Voice glance "Voice 2:14" over
     * "Global Voice · OpenAI Realtime") instead of being squeezed to an ellipsis beside them.
     */
    titleMeta?: React.ReactNode;
    /**
     * Where the source reads: inline after the title, or on its own line beneath. The default puts it
     * beneath on a phone or beside a `titleMeta`; a title that is a user-chosen name (a Session's) and can
     * run long asks for `below` so the source is never pushed out of the header by it.
     */
    sourcePlacement?: 'inline' | 'below';
    /** The widget declares its body names its source (`widgetDefinitionNamesItsSource`): its line is held until it does. */
    sourceHeld?: boolean;
    /**
     * The widget is a section of a page (a core page such as Usage): plain, it still heads its section with a title
     * (lab wgusage), where a plain glance among grouped rows is labelled quietly (lab crows B).
     */
    pageSection?: boolean;
    /** The widget's controls at the end of the header: its ⋯ menu. */
    menu?: React.ReactNode;
    /**
     * The body draws a live picture (an agent's or plugin's HTML page): arbitrary pixels, so the menu
     * and grip open their floating surfaces with the live-picture coat, readable over a white page in dark.
     */
    livePicture?: boolean;
    /** The card's move grip (Canvas, Session Board): always the last control of the header, after the ⋯ menu. */
    grip?: React.ReactNode;
    /** The move handle, before the mark, while the widget's surface is being arranged. */
    leading?: React.ReactNode;
    /** Mounted viewer-local disclosure; never writes the layout or alters Resource activity. */
    disclosure?: HappierControlledDisclosure;
    /**
     * The widget's body. Omitted by a card that says everything in its header (a Board card: title, its
     * description beneath, its quiet facts at the foot), so no empty body room opens between them.
     */
    body?: WidgetFrameBody;
    footer?: WidgetFrameFooter | null;
    /** Reserved body rows. Home keeps {@link HOME_WIDGET_BODY_ROWS}; other placements reserve none. */
    rows?: number;
    /** Resolved presentation facts. Persisted size and native height remain with the placement owner. */
    widgetPresentation?: Pick<WidgetBodyPresentation, 'size' | 'footprint'>;
    /**
     * How the owning surface sizes this frame's body, apart from the body's own size and width:
     * `fixed` (a grid surface: the size's rows, scrolling inside), `grow` (at least those rows, taller
     * when the body is) or `content` (a content-height surface such as a core page: exactly the body).
     * Default: `fixed`; inside a group, `grow` on a grid and `content` on a phone's stack.
     */
    bodyHeight?: 'fixed' | 'grow' | 'content';
    /** Existing native Board height, including its Auto lifecycle; not a second saved height. */
    viewportHeight?: number;
    /** Body box (a measured height, full-bleed insets) for a placement that sizes its body. */
    bodyStyle?: React.ComponentProps<typeof HappierWidgetFrame>['bodyStyle'];
    /**
     * It just arrived while you were looking (the agent added it): a one-shot ring that fades. A
     * number replays the ring each time it changes (a caption asked "where is it?" again).
     */
    fresh?: boolean | number;
    /** Fill the grid cell, so cards in one row share a height. */
    fill?: boolean;
    /**
     * Inside a widget group, or alone on a host surface (a popover, a sheet): the host draws the
     * surface and the dividers, so this frame (always plain there) draws no hairline of its own.
     */
    grouped?: boolean;
    /** First in its area: a plain widget's hairline separates it from the one above, so the first draws none. */
    leadsArea?: boolean;
    accessibilityLabel?: string;
}>;



// The footer links draw at the WCAG 2.2 pointer floor under every pointer; a finger reaches past it through the hit area.
const FOOTER_MIN_TARGET_PX = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;
const FIXED_BODY_FADE_EDGES = { top: true, bottom: true } as const;
/** How long the arrival ring stays before it fades: long enough to find it, short enough to never read as a badge. */
const FRESH_RING_HOLD_MS = 2000;
const FRESH_RING_FADE_MS = 600;

/**
 * The one widget frame (lab `cwidgets` F1, round 2 Card | Plain): mark · title · source · meta · ⋯,
 * a body that keeps its room through loading, empty and error, and one footer — on Home, the Board
 * and the Companion. The structure is `HappierWidgetFrame` (plugin-ui); this adapter supplies
 * Happier's theme, text owner, glyphs, the W1 state bodies and the arrival ring.
 */
/** The room a rendered viewport holds right now, read from the DOM (web only); null until it has one. */
/** A plugin's widget often names its plugin ("New in PRs & Issues"): the header says it once. */
function sourceRepeatsTitle(source: WidgetFrameProps['source'], title: WidgetFrameProps['title']): boolean {
    return typeof source === 'string' && typeof title === 'string'
        && title.toLocaleLowerCase().includes(source.trim().toLocaleLowerCase());
}

function readViewportRoom(node: unknown): WidgetBodyPresentation['geometry'] | null {
    const measure = (node as { getBoundingClientRect?: () => { width: number; height: number } } | null)?.getBoundingClientRect;
    if (typeof measure !== 'function') return null;
    const { width, height } = measure.call(node);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height >= 0 ? { width, height } : null;
}

export const WidgetFrame = React.memo(function WidgetFrame(props: WidgetFrameProps) {
    const reducedMotion = useReducedMotionPreference();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const phone = useDeviceType() === 'phone';
    const inheritedStateSize = useSurfaceStateCardSize();
    const [replacementStates, setReplacementStates] = React.useState<ReadonlyMap<symbol, SurfaceStateContentReport>>(() => new Map());
    const reportContentState = React.useCallback((key: symbol, report: SurfaceStateContentReport | null) => {
        setReplacementStates(previous => {
            const current = previous.get(key);
            if (report === null ? current === undefined
                : current !== undefined && current.empty === report.empty && current.line === report.line && current.loading === report.loading) return previous;
            const next = new Map(previous);
            if (report === null) next.delete(key); else next.set(key, report);
            return next;
        });
    }, []);
    const emptyBody = props.body?.kind === 'empty' || (props.body?.kind === 'content'
        && replacementStates.size > 0 && [...replacementStates.values()].every(report => report.empty));
    // A phone stacks every card in one column, so a card with nothing to show is its one line (F2): a first-run
    // phone page of scenes would run several screens. It takes its content's height; rows return with content.
    const phoneEmpty = phone && emptyBody;
    // A body whose only content is one-line states (offline with nothing cached, "36 machines are offline") is that
    // line on every placement: no reserved rows, and it does not stretch to a taller card beside it (owner 2026-11-11).
    // Loading keeps the room, so nothing below moves when the rows arrive; an empty state keeps the empty rule above.
    const lineBody = props.body?.kind === 'content' && replacementStates.size > 0
        && [...replacementStates.values()].every(report => report.line && !report.loading && !report.empty);
    const contentSized = phoneEmpty || lineBody;
    const bodyFootprint = props.widgetPresentation ? projectWidgetGroupCellContent(
        { id: props.testID, ...props.widgetPresentation.footprint }, props.grouped && emptyBody ? 'empty' : undefined,
    ) : undefined;
    const reservedRows = bodyFootprint ? widgetFootprintBodyRows(bodyFootprint)
        : props.rows ?? (props.placement === 'home' ? HOME_WIDGET_BODY_ROWS : 0);
    const rows = contentSized ? 0 : reservedRows;
    const rowHeight = useWidgetBodyRowHeight();
    const inheritedPresentation = useWidgetPresentation();
    const [geometry, setGeometry] = React.useState<WidgetBodyPresentation['geometry']>();
    const onViewportLayout = React.useCallback((event: HappierLayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height < 0) return;
        setGeometry(previous => previous?.width === width && previous.height === height ? previous : { width, height });
    }, []);
    const widgetPresentation = React.useMemo(() => props.widgetPresentation
        ? { ...props.widgetPresentation, ...(geometry ? { geometry } : {}) } : inheritedPresentation,
        [props.widgetPresentation, geometry, inheritedPresentation]);
    // A widget lays itself out from its measured room (columns, strips, plot height). On the web a layout event
    // reaches it only after the first paint, and a busy page can hold that event for seconds, so the first commit
    // reads the room itself: nothing paints in a layout it is about to leave. A deferred body already
    // has useful width at zero height; retry an unavailable room when that body activates.
    const viewportContentRef = React.useRef<View | null>(null);
    const inset = resolveHappierWidgetFrameInsetPx(props.frameStyle);
    // Inside a group nothing clips (A6): a grid cell keeps its rows' room and grows; a phone's stack is its content.
    // Empty content changes the room, never the wrapper: remounting a body withdraws its empty-state
    // report, restores the fixed wrapper, and starts its credential/data read again.
    const bodyHeight = props.bodyHeight ?? (props.grouped ? phone ? 'content' : 'grow' : 'fixed');
    // A body that sizes itself (a grown or content-height cell) is told its own room: the box its content takes, at
    // least the rows a grown cell keeps. Never the band's: a frame stretched by a taller partner column, or by a
    // partner that grows while it refreshes, leaves that space empty instead of handing it to a chart (lab wgusage-CD).
    const declaredBodyHeight = bodyHeight === 'grow' ? props.viewportHeight ?? rows * rowHeight : 0;
    // A content-height body's own box is only what its content already draws, so a chart sized from it can never
    // draw taller than its first frame (it settles at its floor). Its room is what its footprint declares, at
    // least: nothing is stretched to it (no minHeight), a chart simply reads how tall its cell is meant to be.
    // A phone stacks content with no cell to declare.
    const declaredRoomHeight = bodyHeight === 'content' && !phone && props.widgetPresentation
        ? props.viewportHeight ?? rows * rowHeight : declaredBodyHeight;
    const onBodyBoxLayout = React.useCallback((event: HappierLayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height < 0) return;
        const room = Math.max(height, declaredRoomHeight);
        setGeometry(previous => previous?.width === width && previous.height === room ? previous : { width, height: room });
    }, [declaredRoomHeight]);
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || geometry !== undefined) return;
        // A fixed body's viewport is the scroll area that holds its content row; a sizing body's room is its own box.
        const content = viewportContentRef.current as unknown as Element | null;
        const room = readViewportRoom(bodyHeight !== 'fixed' && props.widgetPresentation ? content
            : content?.closest?.(`[data-testid="${props.testID}.viewport"]`) ?? null);
        if (room) setGeometry(bodyHeight !== 'fixed' ? { ...room, height: Math.max(room.height, declaredRoomHeight) } : room);
    }, [geometry, props.testID, props.widgetPresentation, props.body, bodyHeight, declaredRoomHeight]);
    // A fixed body whose rows run past it fades at the cut edge, so no line reads as cut off mid-height.
    const bodyFades = useScrollEdgeFades({ enabledEdges: FIXED_BODY_FADE_EDGES });
    const onFixedViewportLayout = React.useCallback((event: HappierLayoutChangeEvent) => {
        onViewportLayout(event);
        // The fades read only `nativeEvent.layout`, which the portable layout event carries.
        bodyFades.onViewportLayout(event as unknown as LayoutChangeEvent);
    }, [bodyFades.onViewportLayout, onViewportLayout]);
    const onFixedContentLayout = React.useCallback((event: HappierLayoutChangeEvent) => {
        bodyFades.onContentSizeChange(event.nativeEvent.layout.width, event.nativeEvent.layout.height);
    }, [bodyFades.onContentSizeChange]);
    const bodyFadeMask = Platform.OS === 'web' ? resolveVerticalScrollEdgeMaskStyle(bodyFades.visibility) : null;
    // The one footer row: a failed refresh or a pending change says so first; else the page a plugin body names
    // ("Open Tasks", lent through `PaneHeaderContent onOpen`) leads past whatever its glance left out, in place of
    // the placement's generic Open. A headerless frame belongs to a page section that draws its own link row.
    const [lentOpen, setLentOpen] = React.useState<WidgetFrameBodyOpen | null>(null);
    const placementFooter = props.footer ?? null;
    const footer = React.useMemo<WidgetFrameFooter | null>(() => (
        lentOpen === null || props.title === null || placementFooter?.kind === 'refreshFailed' || placementFooter?.kind === 'pending'
            ? placementFooter
            : { kind: 'open', label: t('homeWidgets.open', { destination: lentOpen.destination }), onPress: lentOpen.onPress }
    ), [lentOpen, placementFooter, props.title]);
    const [refreshingResources, setRefreshingResources] = React.useState<ReadonlySet<symbol>>(() => new Set());
    const reportResourceActivity = React.useCallback((key: symbol, refreshing: boolean) => {
        setRefreshingResources(previous => {
            if (previous.has(key) === refreshing) return previous;
            const next = new Set(previous);
            if (refreshing) next.add(key); else next.delete(key);
            return next;
        });
    }, []);
    // While a read refreshes, the meta slot says so in place of its time (lab ST "Refreshing"): the
    // shared activity glyph and the word, then the time returns. The content below never moves.
    const refreshing = refreshingResources.size > 0;
    // A refresh nobody asked for is quiet work however long it runs: the glyph alone. The frame owns the one
    // refresh button the person presses (the footer's Retry), so only a refresh that button started says the word.
    const [retrying, setRetrying] = React.useState(false);
    const refreshingWords = refreshing && !isWidgetResourceQuietRefresh(true, retrying);
    const retryFooter = footer?.kind === 'refreshFailed' ? footer.onRetry : undefined;
    const onRetry = React.useMemo(() => retryFooter ? () => {
        setRetrying(true);
        return Promise.resolve(retryFooter()).finally(() => setRetrying(false));
    } : undefined, [retryFooter]);
    // Where the header is narrow (the frame's own measured width, never its footprint) the word leaves and the glyph
    // stays, named for assistive technology: a lone dot-matrix glyph beside the grip reads as a second grip, so it
    // is only the fallback for a header with no room for the word.
    const refreshingMark = refreshing ? (
        <View testID={`${props.testID}.refreshing`} style={styles.refreshing} accessibilityLiveRegion="polite"
            accessible accessibilityLabel={t('widgetDefinition.refreshing')}>
            <ActivitySpinner size={ICON_SIZE.xs - 2} color={theme.colors.text.tertiary} />
        </View>
    ) : undefined;
    // A frame drawn headerless (`title={null}`: a page section that owns its title) stays headerless: a refresh
    // never grows an empty header row around a lone spinner; the body's own freshness line speaks for it.
    // The documented meta is "a string, or an element": a string reads in the frame's meta text role on every
    // presentation, never as a raw text node beside the body.
    const authoredMeta = typeof props.meta === 'string' || typeof props.meta === 'number'
        ? <Text testID={`${props.testID}.meta`} style={styles.source} numberOfLines={1}>{props.meta}</Text>
        : props.meta;
    const meta = !refreshing || props.title === null ? authoredMeta : (
        <View testID={`${props.testID}.refreshing`} style={styles.refreshing} accessibilityLiveRegion="polite"
            accessible accessibilityLabel={t('widgetDefinition.refreshing')}>
            <ActivitySpinner size={ICON_SIZE.xs - 2} color={theme.colors.text.tertiary} />
            {refreshingWords ? <Text style={styles.source} numberOfLines={1}>{t('widgetDefinition.refreshing')}</Text> : null}
        </View>
    );
    // The frame sizes every state inside it (W1 bodies, a refusal, a plugin's own): a card's states on
    // Home and a Board, one line under the header in a Companion or other column (lab ST "Compact").
    const stateSize = props.presentation === 'body' ? inheritedStateSize ?? (props.placement === 'companion' ? 'line' : 'pane')
        : phoneEmpty ? 'line'
        : props.grouped && emptyBody && props.widgetPresentation?.footprint.columnSpan === 1 ? 'line'
        // A compact footprint (Small, Wide) has one row of room: its state is the line, balanced in that row.
        : props.widgetPresentation?.footprint.height === 'compact' ? 'line'
        : props.placement === 'companion' ? 'line'
        // A card spanning the whole band has a drawer's room: its state reads at that measure, not a side pane's.
        : props.widgetPresentation?.footprint.width === 'full' ? 'details' : 'pane';

    // A single-line source preserves the suffix that tells near-identical names apart. A stacked phone source
    // uses the frame's full-width two-line measure; a title keeps its tail ellipsis.
    const pageSection = props.pageSection === true;
    const renderText = React.useCallback<HappierWidgetFrameTextRender>((input) => input.role !== 'title' && (input.numberOfLines ?? 1) === 1 && input.text.includes(' · ') ? (
        <MiddleEllipsisText testID={input.testID} style={styles.source} value={input.text} />
    ) : (
        <Text testID={input.testID} style={input.role !== 'title' ? styles.source : input.frameStyle === 'plain' && !pageSection ? styles.sectionLabel : styles.title}
            numberOfLines={input.numberOfLines ?? 1} accessibilityRole={input.role === 'title' ? 'header' : undefined} aria-level={input.role === 'title' ? input.headingLevel ?? 2 : undefined}>{input.text}</Text>
    ), [styles.sectionLabel, styles.source, styles.title, pageSection]);
    // A bound source's glyph from the app's icon family: the pin it is set by, or the link it follows.
    const renderSourceGlyph = React.useCallback((binding: HappierWidgetFrameSourceBinding) => (
        <Icon name={binding === 'pin' ? 'push-pin' : 'link'} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
    ), [theme.colors.text.tertiary]);

    const mark = props.mark === undefined
        ? null
        : typeof props.mark === 'string'
            ? <Icon name={props.mark} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
            : props.mark;

    // A card's footer stands on the inset its frame already gives its facts, so the link keeps the title's edge;
    // plain has no card inset and pads its link itself.
    const footerInset = props.frameStyle === 'plain' ? inset : 0;
    const footerNode = footer?.kind === 'open' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
        <HappierPressable
            testID={`${props.testID}.open`}
            accessibilityRole="link"
            accessibilityLabel={footer.label}
            onPress={footer.onPress}
            style={(state) => [
                styles.footer, { flexGrow: 1 },
                { paddingHorizontal: footerInset, minHeight: props.frameStyle === 'plain' ? undefined : FOOTER_MIN_TARGET_PX },
                state.pressed ? styles.footerPressed : null,
                focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
            ]}
        >
            <Text style={styles.footerLabel} numberOfLines={1}>{footer.label}</Text>
            <Icon name="caret-right" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
        </HappierPressable>
        {footer.secondary ? (
            <HappierPressable
                testID={`${props.testID}.secondary-open`}
                accessibilityRole="link"
                accessibilityLabel={footer.secondary.label}
                onPress={footer.secondary.onPress}
                style={(state) => [styles.footer,
                    { paddingHorizontal: footerInset, minHeight: FOOTER_MIN_TARGET_PX },
                    state.pressed ? styles.footerPressed : null,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
            >
                <Text style={styles.footerLabel}>{footer.secondary.label}</Text>
            </HappierPressable>
        ) : null}
        </View>
    ) : footer?.kind === 'refreshFailed' ? (
        <View style={styles.footerFill}>
            <SurfaceFreshnessLine
                testID={`${props.testID}.stale`}
                reason={footer.reason}
                tone="warning"
                {...(onRetry ? { action: { label: t('common.retry'), onPress: onRetry } } : {})}
            />
        </View>
    ) : footer?.kind === 'pending' ? (
        <View style={styles.footerFill}>
            <SurfaceFreshnessLine testID={`${props.testID}.pending`} reason={footer.reason} busy />
        </View>
    ) : null;

    const menu = props.menu ? <ItemRowActionsTitleContext.Provider value={typeof props.title === 'string' ? props.title : props.accessibilityLabel ?? null}>
        {props.menu}
    </ItemRowActionsTitleContext.Provider> : props.menu;
    const controls = props.grip ? <View style={styles.chrome}>{menu}{props.grip}</View> : menu;
    // A plain widget is a section of its column (lab crows B): with a mouse or trackpad its controls rest out of
    // sight and appear while the pointer is over it or focus is inside it. A finger cannot hover, so on touch they
    // stay shown; a card always shows them.
    const hoverCapable = useHoverCapablePrimaryPointer();
    const revealOnHover = props.frameStyle === 'plain' && hoverCapable && Boolean(props.menu || props.grip);
    const [engagement] = React.useState(createPlainControlsEngagement);
    // One element topology for every style: switching Card and Plain never remounts the menu that made the switch.
    const plainControls = controls
        ? <PlainControls engagement={engagement} revealOnHover={revealOnHover} testID={props.testID}>{controls}</PlainControls>
        : null;
    // Resting out of sight, the controls take no room in the header: they stand over its end, so the meta (a count,
    // "7 needs you") ends on the content edge where the rows' trailing words end. Shown, they keep that place and the
    // meta steps aside by their width (owner 2026-11-11).
    const accessory = plainControls ?? controls;
    const shiftedMeta = revealOnHover && meta ? <PlainMetaShift engagement={engagement} testID={props.testID}>{meta}</PlainMetaShift> : meta;
    const shiftedCompactMeta = revealOnHover && refreshingMark
        ? <PlainMetaShift engagement={engagement} testID={`${props.testID}.compact`}>{refreshingMark}</PlainMetaShift> : refreshingMark;
    const body = props.body;
    if (props.presentation === 'body') {
        return <>{authoredMeta}{body ? <SurfaceStateSizeProvider size={stateSize} actions="quiet">
            <WidgetFrameBodyOpenContext.Provider value={setLentOpen}>
            <WidgetFrameBodyView testID={props.testID} body={body} rows={0} />
            </WidgetFrameBodyOpenContext.Provider>
        </SurfaceStateSizeProvider> : null}{footerNode}</>;
    }
    const frame = (
        <HappierWidgetFrame
            testID={props.testID}
            onOpen={props.onOpen}
            openTarget={props.openTarget}
            facts={props.facts}
            frameStyle={props.frameStyle}
            placement={props.placement}
            {...(props.anatomy ? { anatomy: props.anatomy } : {})}
            cardStyle={styles.card}
            gradient={resolveThemeSurfaceFinish(theme, 'card')}
            renderMaterialSurface={renderThemeMaterialSurface}
            {...(props.grouped || (props.leadsArea && props.frameStyle === 'plain') ? {} : { dividerColor: theme.colors.border.default })}
            mark={mark}
            title={props.titleMeta && typeof props.title === 'string' ? (
                <View style={styles.titleWithMeta}>
                    {renderText({ role: 'title', text: props.title, testID: `${props.testID}.title`, frameStyle: props.frameStyle })}
                    {props.titleMeta}
                </View>
            ) : props.title}
            {...(props.source && !sourceRepeatsTitle(props.source, props.title) ? { source: props.source } : {})}
            renderSourceGlyph={renderSourceGlyph}
            sourcePlacement={props.sourcePlacement ?? (phone || props.titleMeta ? 'below' : 'inline')}
            {...(props.sourceHeld ? { sourceHeld: true } : {})}
            meta={shiftedMeta}
            {...(shiftedCompactMeta ? { compactMeta: shiftedCompactMeta } : {})}
            {...(props.leading ? { leading: props.leading } : {})}
            {...(revealOnHover ? { accessoryPlacement: 'overlay' as const } : {})}
            accessory={props.livePicture && accessory
                ? <GlassLivePictureBackdropContext.Provider value>{accessory}</GlassLivePictureBackdropContext.Provider>
                : accessory}
            disclosure={props.disclosure}
            // The public driver erases Reanimated's host-private value types, as at the plugin presentation boundary.
            disclosureMotion={reanimatedDisclosureMotion as unknown as HappierDisclosureMotionDriver}
            reducedMotion={reducedMotion}
            disclosureColors={props.disclosure ? {
                glyph: theme.colors.text.secondary,
                glyphActive: theme.colors.text.primary,
                focus: theme.colors.border.focus,
            } : undefined}
            renderText={renderText}
            footer={footerNode}
            // A card with a footprint keeps its rows' height unless its host asks it to fill its grid cell (so
            // cards sharing a row share its height); inside a group its cell is the band's, so it fills it.
            fill={contentSized ? false : props.fill ?? (props.widgetPresentation && !props.grouped ? false : props.grouped)}
            bodyStyle={props.bodyStyle}
            accessibilityLabel={props.accessibilityLabel
                ?? (typeof props.source === 'string' && typeof props.title === 'string' ? `${props.title}, ${props.source}` : undefined)}
            overlay={props.fresh ? <WidgetFrameArrivalRing key={String(props.fresh)} frameStyle={props.frameStyle} /> : null}
        >
            {/* A card never owns its page's one primary action: its states' actions are quiet (F1). */}
            {body ? <SurfaceStateSizeProvider size={stateSize} actions="quiet">
                <WidgetFrameBodyRowsContext.Provider value={rows}>
                <WidgetFrameBodyOpenContext.Provider value={setLentOpen}>
                <WidgetPresentationProvider value={widgetPresentation}>
                {props.widgetPresentation && bodyHeight !== 'fixed' ? (
                    // Nothing clips or scrolls here: the body is measured (its size and width still
                    // reach it) and the frame takes the height that results. A frame stretched by its band
                    // (a group's shorter column) grows this viewport, but the body keeps its own box: the
                    // extra height stays empty under it, so nothing it draws stretches or jumps.
                    <View testID={`${props.testID}.viewport`}
                        style={{ minHeight: bodyHeight === 'grow' ? props.viewportHeight ?? rows * rowHeight : undefined, flexGrow: 1, minWidth: 0 }}>
                        <View ref={viewportContentRef} testID={`${props.testID}.viewportBody`} onLayout={onBodyBoxLayout}
                            style={{ minWidth: 0, ...(bodyHeight === 'grow' ? { minHeight: declaredBodyHeight } : {}) }}>
                            <WidgetFrameBodyView testID={props.testID} body={body} rows={rows} />
                        </View>
                    </View>
                ) : props.widgetPresentation ? (
                    <HappierScrollArea testID={`${props.testID}.viewport`} onLayout={onFixedViewportLayout}
                        onScroll={bodyFades.onScroll} scrollEventThrottle={16}
                        scrollEnabled={!contentSized}
                        style={{ height: contentSized ? undefined : props.viewportHeight ?? rows * rowHeight, minWidth: 0,
                            ...(!contentSized && bodyFadeMask ? { maskImage: bodyFadeMask.maskImage, WebkitMaskImage: bodyFadeMask.WebkitMaskImage } : {}) }}
                        contentContainerStyle={{ minHeight: contentSized ? undefined : '100%' }}>
                        <View ref={viewportContentRef} testID={`${props.testID}.viewportContent`} onLayout={onFixedContentLayout} style={styles.fixedBodyContent}>
                            <WidgetFrameBodyView testID={props.testID} body={body} rows={rows} />
                        </View>
                    </HappierScrollArea>
                ) : reservedRows > 0 ? (
                    <WidgetFrameReservedRows rows={rows} rowHeight={rowHeight} centered={body.kind !== 'content'}>
                        <WidgetFrameBodyView testID={props.testID} body={body} rows={rows} />
                    </WidgetFrameReservedRows>
                ) : (
                    <WidgetFrameBodyView testID={props.testID} body={body} rows={rows} />
                )}
                </WidgetPresentationProvider>
                </WidgetFrameBodyOpenContext.Provider>
                </WidgetFrameBodyRowsContext.Provider>
            </SurfaceStateSizeProvider> : null}
        </HappierWidgetFrame>
    );
    return (
        <SurfaceStateContentContext.Provider value={reportContentState}>
        <WidgetFrameResourceActivityContext.Provider value={reportResourceActivity}>
        <View testID={`${props.testID}.hover`} style={props.fill && !contentSized ? styles.hoverFill : styles.hover}
            onPointerEnter={engagement.engage} onPointerLeave={engagement.release}
            // Focus within (a keyboard reaching the ⋯) reveals the controls too; only web has focus capture.
            {...(Platform.OS === 'web' ? { onFocusCapture: engagement.engage, onBlurCapture: engagement.release } : null)}>
            {frame}
        </View>
        </WidgetFrameResourceActivityContext.Provider>
        </SurfaceStateContentContext.Provider>
    );
});

/**
 * Whether the pointer is over a plain widget or focus is inside it. Kept in a per-frame store read only by its
 * controls, so hovering a widget re-renders its ⋯ and move handle, never its body.
 */
type PlainControlsEngagement = Readonly<{
    engage: () => void;
    release: () => void;
    subscribe: (listener: () => void) => () => void;
    read: () => boolean;
    /** How far the meta steps aside while the controls show: their measured width and the header gap. */
    readMetaShift: () => number;
    measureControls: (width: number) => void;
}>;

function createPlainControlsEngagement(): PlainControlsEngagement {
    let engaged = false;
    let controlsWidth = 0;
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of listeners) listener(); };
    const set = (next: boolean) => {
        if (engaged === next) return;
        engaged = next;
        notify();
    };
    return {
        engage: () => set(true),
        release: () => set(false),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        read: () => engaged,
        readMetaShift: () => engaged && controlsWidth > 0 ? -(controlsWidth + HAPPIER_WIDGET_FRAME_METRICS.headerGapPx) : 0,
        measureControls: (width) => {
            const next = Math.round(width);
            if (next === controlsWidth) return;
            controlsWidth = next;
            if (engaged) notify();
        },
    };
}

/** At rest the controls are transparent, not removed: they stay reachable by keyboard. */
const PLAIN_CONTROLS_AT_REST = { opacity: 0 } as const;

/**
 * The meta of a plain widget whose controls rest out of sight: it stays on the header's end and steps aside by a
 * transform while the controls show, so nothing in the header re-lays out. Only this leaf reads the engagement.
 */
const PlainMetaShift = React.memo(function PlainMetaShift(props: Readonly<{
    engagement: PlainControlsEngagement;
    testID: string;
    children: React.ReactNode;
}>) {
    const shift = React.useSyncExternalStore(props.engagement.subscribe, props.engagement.readMetaShift, props.engagement.readMetaShift);
    return <View testID={`${props.testID}.metaShift`} pointerEvents="box-none" style={{ transform: [{ translateX: shift }] }}>{props.children}</View>;
});

const PlainControls = React.memo(function PlainControls(props: Readonly<{
    engagement: PlainControlsEngagement;
    /** A plain widget under a hover-capable pointer; otherwise the controls are always shown. */
    revealOnHover: boolean;
    testID: string;
    children: React.ReactNode;
}>) {
    const engaged = React.useSyncExternalStore(props.engagement.subscribe, props.engagement.read, props.engagement.read);
    const measure = props.engagement.measureControls;
    const onLayout = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
        measure(event.nativeEvent.layout.width);
    }, [measure]);
    return <View testID={`${props.testID}.controls`} {...(props.revealOnHover ? { onLayout } : {})}
        style={!props.revealOnHover || engaged ? null : PLAIN_CONTROLS_AT_REST}>{props.children}</View>;
});

/**
 * Keeps the room of `rows` list rows whatever state the body is in (Home's W1 rule), so nothing
 * below moves when data arrives. Rows are two-line rows of a compact list at the reader's density
 * (widget rows are list rows), so the reserve matches the real rows' box.
 */

/** A state (loading, empty, failed) sits centred in the reserved room; rows start at its top, like any list. */
function WidgetFrameReservedRows(props: Readonly<{ rows: number; rowHeight: number; centered: boolean; children: React.ReactNode }>) {
    return <View style={{ flexGrow: 1, minHeight: props.rows * props.rowHeight, justifyContent: props.centered ? 'center' : 'flex-start' }}>{props.children}</View>;
}

/**
 * The one-shot "just arrived" ring (lab WA): drawn while the frame is fresh, held long enough to be
 * found, then faded. It never persists as a badge. Reduced motion: it simply disappears.
 */
function WidgetFrameArrivalRing(props: Readonly<{ frameStyle: WidgetFrameStyle }>) {
    const styles = stylesheet;
    const reduceMotion = useReducedMotionPreference();
    const opacity = useSharedValue(1);
    React.useEffect(() => {
        opacity.value = withDelay(
            FRESH_RING_HOLD_MS,
            withTiming(0, { duration: reduceMotion ? motionTokens.durationMs.instant : FRESH_RING_FADE_MS }),
        );
    }, [opacity, reduceMotion]);
    const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
    return (
        <Animated.View
            pointerEvents="none"
            testID="widget-frame.arrival-ring"
            style={[styles.ring, props.frameStyle === 'plain' ? styles.ringPlain : null, animated]}
        />
    );
}

function WidgetFrameBodyView(props: Readonly<{ testID: string; body: WidgetFrameBody; rows: number }>) {
    const body = props.body;
    switch (body.kind) {
        case 'content':
            // A widget draws the same rows on Home, a Board and a configuration page: its body starts its own
            // list scope, as a floating surface does, so a host page's column and row insets never reach it.
            return (
                <ListPresentationProvider value="grouped" pageInsets="contained">
                    <SurfaceFreshnessOnSheetProvider>{body.children}</SurfaceFreshnessOnSheetProvider>
                </ListPresentationProvider>
            );
        case 'loading':
            return <WidgetFrameLoadingBody testID={`${props.testID}.loading`} accessibilityLabel={body.accessibilityLabel} rows={props.rows} />;
        case 'empty':
            return (
                <SurfaceStateCard
                    testID={`${props.testID}.empty`}
                    kind="empty"
                    replacesContent
                    title={body.title}
                    reason={body.reason}
                    {...(body.action ? { action: body.action } : {})}
                    {...(body.iconName ? { iconName: body.iconName } : {})}
                    {...(body.scene ? { scene: body.scene } : {})}
                />
            );
        case 'error':
            return (
                <SurfaceStateCard
                    testID={`${props.testID}.error`}
                    kind={body.tone ?? 'error'}
                    title={body.title}
                    reason={body.reason}
                    accessibilitySemantics="status"
                    {...(body.action ? { action: body.action } : {})}
                    {...(body.diagnosticCode ? { diagnosticCode: body.diagnosticCode } : {})}
                    {...(body.iconName ? { iconName: body.iconName } : {})}
                />
            );
    }
}

const stylesheet = StyleSheet.create((theme) => {
    return {
        // The card is the app's in-flow card: the card fill, hairline, lip and grounding every grouped and
        // page sheet shares (W3 on light).
        card: {
            backgroundColor: theme.colors.edge.cardFill,
            ...resolveThemeCardChromeStyle(theme),
        },
        title: {
            ...Typography.default('semiBold'),
            ...happierPageTextMetrics('sectionTitle'),
            color: theme.colors.text.primary,
        },
        // A plain widget's title is the section label over its rows (lab crows B), on every surface.
        sectionLabel: {
            ...Typography.default('regular'),
            ...happierPageTextMetrics('meta'),
            color: theme.colors.text.secondary,
        },
        refreshing: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space.s4,
        },
        // Fills the fixed viewport (a state body keeps its room) and grows past it when the rows do.
        fixedBodyContent: { flexGrow: 1 },
        hover: { minWidth: 0 },
        hoverFill: { minWidth: 0, flexGrow: 1 },
        chrome: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space.s2,
        },
        titleWithMeta: {
            flexDirection: 'row',
            alignItems: 'baseline',
            gap: theme.space.s6,
        },
        source: {
            ...Typography.default('regular'),
            ...happierPageTextMetrics('meta'),
            color: theme.colors.text.tertiary,
        },
        footer: {
            flex: 1,
            alignSelf: 'stretch',
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space.s4,
        },
        footerFill: {
            flex: 1,
        },
        footerPressed: {
            opacity: motionTokens.press.opacity,
        },
        footerLabel: {
            ...Typography.default('medium'),
            ...happierPageTextMetrics('meta'),
            color: theme.colors.text.primary,
        },
        ring: {
            ...RNStyleSheet.absoluteFillObject,
            borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx,
            borderWidth: 2,
            borderColor: theme.colors.state.info.border,
        },
        ringPlain: {
            // A plain widget has no corner of its own; the ring still marks its rows.
            borderRadius: HAPPIER_WIDGET_FRAME_METRICS.cardRadiusPx / 2,
        },
    };
});
