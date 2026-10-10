import * as React from 'react';
import { PanResponder, Platform, View } from 'react-native';
import type { GestureResponderEvent, PanResponderGestureState } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DrawnLinePath } from '@/components/instrument';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type {
    BrowserAnnotationCaptureCapability,
    BrowserAnnotationViewportRect,
} from '@/sync/domains/browser/context';

import { shadowLevelStyle } from '@/shadowElevation';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';

import { BROWSER_CHROME_WIDTH } from '../browserChromeDensity';

import {
    rectFromGesture,
    sanitizeStrokePath,
    type AnnotationGesturePoint,
} from './annotationGesture';

/**
 * ANNO-1 in-page annotation editor tools. `select` marks an element via the element-picker bridge;
 * `region` draws a marquee rect; `draw` captures a freehand stroke; `erase` removes a pending mark.
 * Keyboard shortcuts mirror T3's PickPreload taxonomy: V / R / D / E.
 */
export type AnnotationEditorTool = 'select' | 'region' | 'draw' | 'erase';

export type AnnotationEditorMark = Readonly<{
    draftId: string;
    kind: 'element' | 'region' | 'stroke';
    label: string;
    rect?: BrowserAnnotationViewportRect;
    points?: readonly AnnotationGesturePoint[];
}>;

export type AnnotationEditorSelectCapability =
    | Readonly<{ available: true }>
    | Readonly<{ available: false; disabledReason: string }>;

const TOOL_SHORTCUTS: Readonly<Record<string, AnnotationEditorTool>> = {
    v: 'select',
    r: 'region',
    d: 'draw',
    e: 'erase',
};

const TOOL_ORDER: readonly AnnotationEditorTool[] = ['select', 'region', 'draw', 'erase'];

function toolLabel(tool: AnnotationEditorTool): string {
    switch (tool) {
        case 'select':
            return t('browserContext.editor.toolSelect');
        case 'region':
            return t('browserContext.editor.toolRegion');
        case 'draw':
            return t('browserContext.editor.toolDraw');
        case 'erase':
            return t('browserContext.editor.toolErase');
    }
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'space-between',
    },
    surface: {
        flex: 1,
    },
    // The active capture layer stays visually transparent so the marked page is fully visible; it
    // only intercepts the pointer gestures that build the draft.
    surfaceActive: {
        backgroundColor: 'transparent',
    },
    visualLayer: {
        ...StyleSheet.absoluteFillObject,
    },
    // Marks are drawn over ARBITRARY page content, so no single ink can be guaranteed legible.
    // Every mark is therefore cased: a light hairline just outside a dark line. One of the two
    // always separates from whatever is underneath, which is how a map draws a road over terrain,
    // and it is what makes SC 1.4.11 satisfiable here at all — the marks are the only indication
    // that a region is selected.
    rectMark: {
        position: 'absolute',
        borderWidth: 2,
        borderRadius: 4,
        borderColor: theme.colors.button.primary.background,
        backgroundColor: 'transparent',
    },
    rectMarkCasing: {
        ...StyleSheet.absoluteFillObject,
        margin: -3,
        borderWidth: 1,
        borderRadius: 6,
        borderColor: theme.colors.surface.base,
    },
    // Element vs region is a difference of LINE STYLE, not of hue: a user who cannot separate the
    // theme's amber from its ink still sees solid against dashed.
    elementMark: {
        borderStyle: 'solid',
    },
    regionMark: {
        borderStyle: 'dashed',
    },
    strokeMark: {
        position: 'absolute',
    },
    strokeLayer: {
        ...StyleSheet.absoluteFillObject,
    },
    // The tray rises from the frame's bottom edge (lab `browser` N): the page stays in view above
    // it, and it is the one place the marking tools live.
    trayDock: {
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingBottom: 12,
    },
    tray: {
        width: '100%',
        maxWidth: BROWSER_CHROME_WIDTH.card,
        gap: 10,
        padding: 10,
        borderRadius: 16,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    trayRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    grow: {
        flex: 1,
        minWidth: 0,
    },
    meta: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    warning: {
        ...Typography.rowMeta(),
        // Q2 measured the theme's semantic FOREGROUNDS as text at 2.20–3.55:1 in light theme —
        // they are fill colours, not text colours; the words carry the meaning in `text.primary`.
        color: theme.colors.text.primary,
    },
    markRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
}));

/**
 * The pointer-capture layer over the active view. Reuses the element-picker overlay pattern (an
 * absolute View that intercepts gestures above the rendered page). Each tool maps a gesture to one
 * callback:
 *  - `select` → tap → `onPick(point)` (the host bridges the picked element into `addDraftTarget`)
 *  - `region` → marquee drag → `onRegion(rect)`
 *  - `draw` → freehand drag → `onStroke(points)`
 *  - `erase` → inert (marks are removed from the panel chips)
 * The callbacks are real props of this component (not leaked onto a host View) so the host can wire
 * them to the canonical annotation adapter and tests can drive them deterministically.
 */
export function AnnotationCaptureSurface(props: Readonly<{
    testID: string;
    tool: AnnotationEditorTool;
    disabled: boolean;
    onPick: (point: AnnotationGesturePoint) => void;
    onRegion: (rect: BrowserAnnotationViewportRect) => void;
    onStroke: (points: readonly AnnotationGesturePoint[]) => void;
}>): React.ReactElement {
    const toolRef = React.useRef(props.tool);
    toolRef.current = props.tool;
    const disabledRef = React.useRef(props.disabled);
    disabledRef.current = props.disabled;
    const handlersRef = React.useRef(props);
    handlersRef.current = props;
    const startRef = React.useRef<AnnotationGesturePoint | null>(null);
    const pathRef = React.useRef<AnnotationGesturePoint[]>([]);

    const responder = React.useMemo(
        () =>
            PanResponder.create({
                onStartShouldSetPanResponder: () => !disabledRef.current,
                onMoveShouldSetPanResponder: () => !disabledRef.current,
                onPanResponderGrant: (event: GestureResponderEvent) => {
                    const point = {
                        x: event.nativeEvent.locationX,
                        y: event.nativeEvent.locationY,
                    };
                    startRef.current = point;
                    pathRef.current = [point];
                },
                onPanResponderMove: (event: GestureResponderEvent) => {
                    pathRef.current.push({
                        x: event.nativeEvent.locationX,
                        y: event.nativeEvent.locationY,
                    });
                },
                onPanResponderRelease: (
                    event: GestureResponderEvent,
                    _gesture: PanResponderGestureState,
                ) => {
                    const start = startRef.current;
                    const end = {
                        x: event.nativeEvent.locationX,
                        y: event.nativeEvent.locationY,
                    };
                    startRef.current = null;
                    const path = pathRef.current;
                    pathRef.current = [];
                    if (disabledRef.current || !start) return;
                    const current = handlersRef.current;
                    switch (toolRef.current) {
                        case 'region': {
                            const rect = rectFromGesture(start, end);
                            if (rect) current.onRegion(rect);
                            else current.onPick(end);
                            return;
                        }
                        case 'draw': {
                            const points = sanitizeStrokePath(path.length > 1 ? path : [start, end]);
                            if (points.length >= 2) current.onStroke(points);
                            return;
                        }
                        case 'select':
                            current.onPick(end);
                            return;
                        case 'erase':
                            return;
                    }
                },
            }),
        [],
    );

    return (
        <View
            testID={props.testID}
            style={[stylesheet.surface, props.disabled ? undefined : stylesheet.surfaceActive]}
            {...(props.disabled ? {} : responder.panHandlers)}
        />
    );
}

function rectStyle(rect: BrowserAnnotationViewportRect): Readonly<Record<string, number>> {
    return {
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
    };
}

function resolveStrokeBounds(points: readonly AnnotationGesturePoint[]): BrowserAnnotationViewportRect | null {
    if (points.length === 0) return null;
    let minX = points[0]?.x ?? 0;
    let minY = points[0]?.y ?? 0;
    let maxX = minX;
    let maxY = minY;
    for (const point of points) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }
    return {
        x: minX,
        y: minY,
        width: Math.max(maxX - minX, 8),
        height: Math.max(maxY - minY, 8),
    };
}

/**
 * The freehand stroke, as ONE path.
 *
 * It used to be a dashed box containing one 6×6 `View` per sampled point — up to 512 of them for a
 * single mark, and a shape that showed the stroke's bounding box rather than the line the user
 * drew. This is the line, through the kit's {@link DrawnLinePath}, which is the canonical owner of
 * "a path that draws itself in": Skia path-trim at the `full` motion level, the shared opacity
 * entrance elsewhere and on web, and no motion at all under reduce-motion. It is also the product's
 * most distinctive interaction finally looking like itself — the mark draws in over ~440ms on
 * commit instead of appearing as dots.
 *
 * Two paths, not one: a `surface.base` casing under the ink, so the stroke stays visible over page
 * content of any colour (see the `rectMark` note above).
 */
function AnnotationStrokeMark(props: Readonly<{
    testID: string;
    draftId: string;
    points: readonly AnnotationGesturePoint[];
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const bounds = resolveStrokeBounds(props.points);
    if (!bounds) return null;

    // Path coordinates are relative to the mark's own box so the SVG viewBox stays at the origin.
    const path = props.points
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${(point.x - bounds.x).toFixed(2)} ${(point.y - bounds.y).toFixed(2)}`)
        .join(' ');

    return (
        <View
            testID={`${props.testID}-mark-${props.draftId}`}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[stylesheet.strokeMark, rectStyle(bounds)]}
        >
            <View style={stylesheet.strokeLayer}>
                <DrawnLinePath
                    testID={`${props.testID}-mark-${props.draftId}-casing`}
                    path={path}
                    width={bounds.width}
                    height={bounds.height}
                    color={theme.colors.surface.base}
                    strokeWidth={5}
                />
            </View>
            <View style={stylesheet.strokeLayer}>
                <DrawnLinePath
                    testID={`${props.testID}-mark-${props.draftId}-path`}
                    path={path}
                    width={bounds.width}
                    height={bounds.height}
                    color={theme.colors.button.primary.background}
                    strokeWidth={2.5}
                />
            </View>
        </View>
    );
}

function AnnotationVisualMarks(props: Readonly<{
    testID: string;
    marks: readonly AnnotationEditorMark[];
}>): React.ReactElement | null {
    const visibleMarks = props.marks.filter((mark) => (
        mark.rect || (mark.kind === 'stroke' && mark.points && mark.points.length > 0)
    ));
    if (visibleMarks.length === 0) {
        return null;
    }
    return (
        <View testID={`${props.testID}-marks`} pointerEvents="none" style={stylesheet.visualLayer}>
            {visibleMarks.map((mark) => {
                if (mark.kind === 'stroke') {
                    return (
                        <AnnotationStrokeMark
                            key={mark.draftId}
                            testID={props.testID}
                            draftId={mark.draftId}
                            points={mark.points ?? []}
                        />
                    );
                }
                if (!mark.rect) return null;
                return (
                    <View
                        key={mark.draftId}
                        testID={`${props.testID}-mark-${mark.draftId}`}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={[
                            stylesheet.rectMark,
                            mark.kind === 'element' ? stylesheet.elementMark : stylesheet.regionMark,
                            rectStyle(mark.rect),
                        ]}
                    >
                        <View style={stylesheet.rectMarkCasing} />
                    </View>
                );
            })}
        </View>
    );
}

export type AnnotationEditorOverlayProps = Readonly<{
    testID: string;
    captureCapability: BrowserAnnotationCaptureCapability;
    selectCapability?: AnnotationEditorSelectCapability;
    /** Number of visible editor marks in the draft — gates Attach (disabled until >=1). */
    markCount: number;
    marks: readonly AnnotationEditorMark[];
    comment: string;
    onSelectElement: () => void;
    onAddRegion: (rect: BrowserAnnotationViewportRect) => void;
    onAddStroke: (points: readonly AnnotationGesturePoint[]) => void;
    onRemoveMark: (draftId: string) => void;
    onCommentChange: (comment: string) => void;
    onAttach: () => void;
    onCancel: () => void;
}>;

/**
 * ANNO-1 in-page annotation editor overlay. An app-layer overlay over the canonical browser-context
 * adapter (NOT an in-page guest preload) so the Wry / iframe / RN engines host it uniformly. Each
 * tool dispatches a single DRAFT action through the host (which routes through
 * `createBrowserContextAnnotationAdapter`); Attach commits the accumulated draft into grouped context
 * items. Attach is disabled until >=1 mark AND the engine has a capture producer, so an empty or
 * unbacked draft never produces a fabricated item (fail-closed).
 */
export function AnnotationEditorOverlay(props: AnnotationEditorOverlayProps): React.ReactElement {
    const { theme } = useUnistyles();
    const [tool, setTool] = React.useState<AnnotationEditorTool>('select');
    const captureAvailable = props.captureCapability.available;
    const selectAvailable = props.selectCapability?.available !== false;
    const activeToolDisabled = !captureAvailable || (tool === 'select' && !selectAvailable);
    const attachDisabled = props.markCount < 1 || !captureAvailable;

    // V / R / D / E shortcuts (web only; native has no key events here). Ignored while typing in the
    // comment field so the letters land in the text, not the toolbar.
    React.useEffect(() => {
        if (Platform.OS !== 'web') return undefined;
        const target = (globalThis as { document?: Document }).document;
        if (!target || typeof target.addEventListener !== 'function') return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const node = event.target as { tagName?: string } | null;
            const tag = node?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea') return;
            const next = TOOL_SHORTCUTS[event.key.toLowerCase()];
            if (next === 'select' && !selectAvailable) return;
            if (next) setTool(next);
        };
        target.addEventListener('keydown', onKeyDown as EventListener);
        return () => target.removeEventListener('keydown', onKeyDown as EventListener);
    }, [selectAvailable]);

    // Escape cancels marking from anywhere, through the canonical escape stack (H-UX F-22), above the
    // browser's own stop-loading layer and below popovers and modals.
    const onCancel = props.onCancel;
    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.overlay,
        onEscape: () => {
            onCancel();
            return true;
        },
    });

    const tools = React.useMemo(() => TOOL_ORDER.map((candidate) => ({
        id: candidate,
        label: toolLabel(candidate),
        ...(candidate === 'select' && !selectAvailable
            ? { disabled: true, unavailableReason: t('browserContext.editor.selectUnavailable') }
            : {}),
    })), [selectAvailable]);

    return (
        <View testID={props.testID} style={stylesheet.root} pointerEvents="box-none">
            <AnnotationCaptureSurface
                testID={`${props.testID}-surface`}
                tool={tool}
                disabled={activeToolDisabled}
                onPick={props.onSelectElement}
                onRegion={props.onAddRegion}
                onStroke={props.onAddStroke}
            />
            <AnnotationVisualMarks testID={props.testID} marks={props.marks} />
            <View style={stylesheet.trayDock} pointerEvents="box-none">
                <GlassSurface surfaceGroup="floating" style={stylesheet.tray} accessibilityRole="toolbar" accessibilityLabel={t('browserContext.editor.title')}>
                    <View style={stylesheet.trayRow}>
                        <SegmentedTabBar<AnnotationEditorTool>
                            tabs={tools}
                            activeTabId={tool}
                            onSelectTab={setTool}
                            role="radiogroup"
                            compact
                            segmentSizing="content"
                            slidingThumb
                            accessibilityLabel={t('browserContext.editor.title')}
                            testIDPrefix={`${props.testID}-tool`}
                        />
                        <View style={stylesheet.grow} />
                        <Text style={stylesheet.meta}>
                            {t('browserContext.editor.marked', { count: String(props.markCount) })}
                        </Text>
                    </View>

                    {captureAvailable ? null : (
                        <Text testID={`${props.testID}-capture-unavailable`} style={stylesheet.warning}>
                            {t('browserContext.editor.captureUnavailable')}
                        </Text>
                    )}
                    {selectAvailable ? null : (
                        <Text testID={`${props.testID}-select-unavailable`} style={stylesheet.warning}>
                            {t('browserContext.editor.selectUnavailable')}
                        </Text>
                    )}

                    {tool === 'erase' && props.marks.length > 0 ? (
                        <View style={stylesheet.markRow}>
                            {props.marks.map((mark) => (
                                <RoundButton
                                    key={mark.draftId}
                                    testID={`${props.testID}-erase-${mark.draftId}`}
                                    size="small"
                                    display="secondary"
                                    title={mark.label}
                                    trailing={<Icon name="x" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                                    accessibilityLabel={t('browserContext.editor.removeMark', { label: mark.label })}
                                    onPress={() => props.onRemoveMark(mark.draftId)}
                                />
                            ))}
                        </View>
                    ) : null}

                    <FieldTextInput
                        testID={`${props.testID}-comment`}
                        value={props.comment}
                        onChangeText={props.onCommentChange}
                        accessibilityLabel={t('browserContext.editor.commentPlaceholder')}
                        placeholder={t('browserContext.editor.commentPlaceholder')}
                        multiline
                        minLines={1}
                    />

                    <View style={stylesheet.trayRow}>
                        <View style={stylesheet.grow} />
                        <RoundButton
                            testID={`${props.testID}-cancel`}
                            size="small"
                            display="secondary"
                            title={t('browserContext.editor.cancel')}
                            onPress={props.onCancel}
                        />
                        <RoundButton
                            testID={`${props.testID}-attach`}
                            size="small"
                            title={t('browserContext.editor.attach')}
                            disabled={attachDisabled}
                            onPress={props.onAttach}
                        />
                    </View>
                </GlassSurface>
            </View>
        </View>
    );
}
