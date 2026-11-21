import * as React from 'react';
import { View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { fillViewTransform, type HappierLiveStreamInputMode, type HappierLiveStreamRect, type HappierLiveStreamViewTransform,
    type RemoteViewerControls } from '@happier-dev/plugin-ui/presentation';
import { createPersistentUiState, usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ScrollEdgeFades, type ScrollEdgeFadeVisibility } from '@/components/ui/scroll/ScrollEdgeFades';
import { useDeviceType } from '@/utils/platform/responsive';
import type { RemoteViewerActions } from '@happier-dev/plugin-ui/presentation';

/** A viewer preference, scoped by its producer to Home, Account, Machine and source identity. */
export const remoteViewerModes = createPersistentUiState<HappierLiveStreamInputMode>('remote-viewer-input-mode-v1',
    value => value === 'trackpad' ? 'trackpad' : 'direct');
const FIT: HappierLiveStreamViewTransform = { scale: 1, x: 0, y: 0 };
export type RemoteViewerStageControls = RemoteViewerControls & Readonly<{
    zoomReset: number;
    /** Where the view rests and Reset returns: the whole picture, or the fill a passive phone viewer gets. */
    restTransform: HappierLiveStreamViewTransform;
    /** One finger pans the zoomed picture (a viewer who only watches) instead of sending a swipe. */
    dragPansView: boolean;
    onViewTransformChange(transform: HappierLiveStreamViewTransform): void;
    renderCursor(position: Readonly<{ x: number; y: number }>): React.ReactNode;
    renderDragTrail(points: readonly Readonly<{x: number; y: number}>[]): React.ReactNode;
}>;
export type RemoteViewerHostActions = RemoteViewerActions & Readonly<{
    inputMode: Readonly<{ value: HappierLiveStreamInputMode; setMode(mode: HappierLiveStreamInputMode): void }>;
    resetZoom(): void;
}>;
const NO_FILL_EDGES: ScrollEdgeFadeVisibility = Object.freeze({ top: false, bottom: false, left: false, right: false });

/**
 * Whether this viewer's picture fills its pane at rest (owner 2026-11-20): on a phone, a viewer who watches and
 * does not drive the source. The remote page or screen keeps its own size; only this viewer's view changes.
 */
export function useRemoteViewerFillsPane(passive: boolean): boolean {
    return useDeviceType() === 'phone' && passive;
}

/** The sides of the drawn picture that continue past the pane under the current view. */
export function remoteViewerContinuingEdges(viewport: Readonly<{ width: number; height: number }>, content: HappierLiveStreamRect,
    transform: HappierLiveStreamViewTransform): ScrollEdgeFadeVisibility {
    return {
        top: content.y * transform.scale + transform.y < -0.5,
        bottom: (content.y + content.height) * transform.scale + transform.y > viewport.height + 0.5,
        left: content.x * transform.scale + transform.x < -0.5,
        right: (content.x + content.width) * transform.scale + transform.x > viewport.width + 0.5,
    };
}

const styles = StyleSheet.create({
    root: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
    edges: { ...StyleSheet.absoluteFillObject, pointerEvents: 'none' },
    picture: { ...StyleSheet.absoluteFillObject },
    cursor: { position: 'absolute', pointerEvents: 'none' },
});

/** Picture and local viewport share one leaf; cursor frames never rerender the host screen. */
export function RemoteViewerStage(props: Readonly<{
    viewerKey?: string;
    viewport: Readonly<{ width: number; height: number }>;
    /** Where the picture is drawn whole in the viewport (contain); the fill and the edges derive from it. */
    content?: HappierLiveStreamRect | null;
    /** The picture's own size in viewport units; the fill never draws it larger. Unknown: it is not filled. */
    pictureSize?: Readonly<{ width: number; height: number }> | null;
    /** This viewer watches without driving the source. */
    passive?: boolean;
    enabled: boolean;
    children: React.ReactNode;
    renderInput(controls: RemoteViewerStageControls): React.ReactNode;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    // Canonical source keys contain nested JSON escapes; MMKV keys reject backslashes.
    const storageKey = props.viewerKey ? encodeURIComponent(props.viewerKey) : null;
    const retained = usePersistentUiStateValue(remoteViewerModes, storageKey);
    const [temporaryMode, setTemporaryMode] = React.useState<HappierLiveStreamInputMode>('direct');
    const mode = props.viewerKey ? retained ?? 'direct' : temporaryMode;
    const content = props.content ?? null;
    const fill = useRemoteViewerFillsPane(props.passive === true) && content !== null;
    const { width: viewportWidth, height: viewportHeight } = props.viewport;
    const contentX = content?.x ?? 0;
    const contentY = content?.y ?? 0;
    const contentWidth = content?.width ?? 0;
    const contentHeight = content?.height ?? 0;
    const pictureWidth = props.pictureSize?.width ?? contentWidth;
    const pictureHeight = props.pictureSize?.height ?? contentHeight;
    const restTransform = React.useMemo(() => fill
        ? fillViewTransform({ width: viewportWidth, height: viewportHeight }, { x: contentX, y: contentY, width: contentWidth, height: contentHeight },
            { width: pictureWidth, height: pictureHeight })
        : FIT, [fill, viewportWidth, viewportHeight, contentX, contentY, contentWidth, contentHeight, pictureWidth, pictureHeight]);
    // The input layer's gesture owner publishes the view it holds; until it does (or after Reset) the view rests.
    const [published, setPublished] = React.useState<HappierLiveStreamViewTransform | null>(null);
    const transform = published ?? restTransform;
    const [zoomReset, setZoomReset] = React.useState(0);
    // Taking or handing back control starts from that viewer's resting view, never from the other one's zoom.
    const [fillShown, setFillShown] = React.useState(fill);
    if (fillShown !== fill) {
        setFillShown(fill);
        setPublished(null);
        setZoomReset(value => value + 1);
    }
    const setMode = React.useCallback((next: HappierLiveStreamInputMode) => {
        if (storageKey) remoteViewerModes.set(storageKey, next);
        else setTemporaryMode(next);
    }, [storageKey]);
    const resetZoom = React.useCallback(() => { setPublished(null); setZoomReset(value => value + 1); }, []);
    const onViewTransformChange = React.useCallback((next: HappierLiveStreamViewTransform) => {
        setPublished(current => current && current.scale === next.scale && current.x === next.x && current.y === next.y ? current : next);
    }, []);
    const renderCursor = React.useCallback((position: Readonly<{ x: number; y: number }>) => props.enabled
        ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            style={[styles.cursor, { left: position.x, top: position.y }]} testID={`${props.testID}-cursor`}>
            <Icon name="cursor" size={ICON_SIZE.md} weight="fill" color={theme.colors.text.primary} />
        </View> : null, [props.enabled, props.testID, theme.colors.text.primary]);
    const renderDragTrail = React.useCallback((points: readonly Readonly<{x: number; y: number}>[]) => props.enabled && points.length > 1
        ? <Svg pointerEvents="none" style={StyleSheet.absoluteFillObject} width={props.viewport.width} height={props.viewport.height}
            testID={`${props.testID}-drag-trail`}><Polyline points={points.map(point => `${point.x},${point.y}`).join(' ')}
                fill="none" stroke={theme.colors.text.primary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg> : null,
        [props.enabled, props.testID, props.viewport.width, props.viewport.height, theme.colors.text.primary]);
    const controls = React.useMemo(() => ({ mode, setMode, resetZoom, zoomReset, restTransform, dragPansView: fill,
        onViewTransformChange, renderCursor, renderDragTrail }),
    [mode, setMode, resetZoom, zoomReset, restTransform, fill, onViewTransformChange, renderCursor, renderDragTrail]);
    // A filled picture says which sides continue, so nothing past the pane is silently hidden. The edge fades
    // toward the stage's own tint, so a white page still shows it continues in the light theme.
    const edges = fill && content ? remoteViewerContinuingEdges(props.viewport, content, transform) : NO_FILL_EDGES;
    const continues = edges.top || edges.bottom || edges.left || edges.right;
    return <View style={styles.root}>
        <View testID={`${props.testID}-view`} style={[styles.picture, { transform: [
            { translateX: transform.x + (transform.scale - 1) * props.viewport.width / 2 },
            { translateY: transform.y + (transform.scale - 1) * props.viewport.height / 2 },
            { scale: transform.scale },
        ] }]}>{props.children}</View>
        {continues ? <View testID={`${props.testID}-continues`} style={styles.edges}>
            <ScrollEdgeFades color={theme.colors.surface.inset} edges={edges} />
        </View> : null}
        {props.renderInput(controls)}
    </View>;
}
