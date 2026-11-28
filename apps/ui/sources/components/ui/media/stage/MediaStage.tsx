import * as React from 'react';
import { FlatList, PixelRatio, Platform, Pressable, ScrollView, View, type ViewToken } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { ScopedTheme, StyleSheet, useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { Icon } from '@/components/ui/icons/Icon';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import {
  coverRectFlipOrigin,
  ENTER_FROM_RECT_MS,
  useRectFlip,
  type WindowFlightRect,
} from '@/components/ui/motion/rectFlight';
import { rectFlipFrame } from '@/components/ui/motion/rectFlipGeometry';
import { measureInWindow } from '@/components/ui/popover/measure';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { previewUnavailableCard, resolvePreviewUnavailable } from '../previewUnavailable';
import { Text } from '@/components/ui/text/Text';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ESCAPE_LAYER_PRIORITIES, EscapeLayerProvider, useEscapeLayer } from '@/keyboard/escape';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { useDeviceType, usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { canOpenFileInDefaultApp, saveFileUri } from '@/sync/runtime/files/saveFileBytes';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { SessionPaneLazyLoader } from '@/components/sessions/panes/SessionPaneLazyLoader';
import type { MediaPlayerBodyProps } from '@/components/workspaces/files/file/MediaPlayerBody';
import type { MediaPlayerFrame, MediaPlayerVideoControls } from '@/components/workspaces/files/file/videoFrameAccess';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';
import type { PdfViewerProps } from '../pdf/PdfViewerStates';
import type { PdfZoom } from '../pdf/pdfZoom';

import { HappierImageCheckerboard } from '@happier-dev/plugin-ui/presentation';
import { useImageBacking } from '../imageBacking';
import { MediaPicture, type MediaPictureSize } from '../MediaPicture';
import { useFilePreviewSource, type FilePreviewSourceState } from '../useFilePreviewSource';
import type { ImageAnnotator } from '../annotation/annotatorStore';
import { AnnotatorCanvas } from '../annotation/AnnotatorCanvas';
import { AnnotatorCaptionSlot, AnnotatorPalette } from '../annotation/AnnotatorPalette';
import { AnnotatorPictureFrame } from '../annotation/AnnotatorPictureFrame';
import { AnnotatorSteps, useAnnotatorShowsSteps } from '../annotation/AnnotatorSteps';
import { useAnnotatorHoldsFinger } from '../annotation/useImageAnnotator';
import { useWheelZoom } from '../zoom/useWheelZoom';
import { useZoomableViewport } from '../zoom/useZoomableViewport';
import { dismissPresentation, resolveZoomBounds } from '../zoom/zoomGeometry';
import type { MediaStageItem, MediaStageProps } from './mediaStageItems';
import { hideStageOrigin } from './hideStageOrigin';
import { useMediaStageGallery } from './useMediaStageGallery';
import { useMediaStageKeyboard } from './useMediaStageKeyboard';
import { useMediaStageAnnotation } from './useMediaStageAnnotation';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
  StageAnnotateActions,
  StageAnnotateCaption,
  StageAnnotateEntry,
  StageAnnotatorMount,
  StageCopyChooser,
  useStageCapsuleLayout,
  type StageAnnotateCapsule,
} from './MediaStageAnnotate';

type Rect = WindowFlightRect;
type Phase = 'opening' | 'open' | 'closing';

/** Desktop chrome geometry, composed from the stage's own parts (lab files MS1 spec). */
const TOP_BAR_HEIGHT = 44;
const STRIP_THUMB_SIZE = 56;
/** The numbered comments' side panel beside the picture (lab `comments` A). */
const STEPS_PANEL_WIDTH = 320;
const STRIP_RING_WIDTH = 2;

const isPicture = (item: MediaStageItem) =>
  item.kind === 'image' || item.kind === 'svg';

function fitSize(size: MediaPictureSize, viewport: MediaPictureSize): MediaPictureSize {
  const scale = Math.min(1, viewport.width / size.width, viewport.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

function fitRect(size: MediaPictureSize, viewport: Rect): Rect {
  const scale = Math.min(
    1,
    viewport.width / size.width,
    viewport.height / size.height,
  );
  const width = size.width * scale;
  const height = size.height * scale;
  return {
    x: viewport.x + (viewport.width - width) / 2,
    y: viewport.y + (viewport.height - height) / 2,
    width,
    height,
  };
}

async function measureOrigin(item: MediaStageItem): Promise<Rect | null> {
  const node = item.originRef?.current;
  if (!node) return null;
  const rect = await measureInWindow(node);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function itemLabel(
  item: MediaStageItem,
  size: MediaPictureSize | null,
): string {
  return size
    ? t('files.viewer.stageItem', {
        name: item.title,
        width: Math.round(size.width),
        height: Math.round(size.height),
      })
    : item.title;
}

type ViewerHandle = Readonly<{
  visibleFrame: () => Rect | null;
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  actual: () => void;
}>;

type StageViewerProps = Readonly<{
  items: readonly MediaStageItem[];
  index: number;
  viewport: Rect;
  window: Rect;
  phase: Phase;
  reducedMotion: boolean;
  progress: SharedValue<number>;
  dragProgress: SharedValue<number>;
  immersive: SharedValue<number>;
  onSize: (index: number, size: MediaPictureSize | null) => void;
  onPage: (direction: -1 | 1) => void;
  onDismiss: (velocityY: number) => void;
  onTap: () => void;
  onZoomChange: (percent: number | null) => void;
  /** While zoomed the picture stays inside the viewport, so the title and capsules stay legible over it. */
  clip: boolean;
  onOpenFile?: () => void;
  onPreviewChange: (index: number, preview: FilePreviewSourceState) => void;
  onDownload?: () => void;
  onOpenInDefaultApp?: () => void;
  /** Annotate mode: the canvas lies on the picture and takes the pointer; zoom keeps working (MIS §8). */
  annotator: ImageAnnotator | null;
  /** The active video's transport, so a paused frame can be read and marked. */
  onVideoControls?: (controls: MediaPlayerVideoControls | null) => void;
}>;

/** A fitted, non-interactive neighbour on either side of the current page. */
function NeighbourPicture(
  props: Readonly<{ item: MediaStageItem; viewport: Rect; enabled: boolean }>,
) {
  const preview = useFilePreviewSource({
    ...props.item.source,
    enabled:
      props.enabled && isPicture(props.item) && props.item.source.enabled,
  });
  const [size, setSize] = React.useState<MediaPictureSize | null>(null);
  if (preview.status !== 'loaded') return null;
  const rect = size ? fitRect(size, { ...props.viewport, x: 0, y: 0 }) : null;
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, stageStyles.centre]}
    >
      <MediaPicture
        kind={props.item.kind === 'svg' ? 'svg' : 'image'}
        uri={preview.uri}
        size={rect ? { width: rect.width, height: rect.height } : null}
        onIntrinsicSize={setSize}
      />
    </View>
  );
}

const StageViewer = React.forwardRef<ViewerHandle, StageViewerProps>(
  function StageViewer(props, ref) {
    const { theme } = useUnistyles();
    const phone = useDeviceType() === 'phone';
    const item = props.items[props.index]!;
    const picture = isPicture(item);
    // Retry asks for fresh bytes; the first attempt keeps the caller's identity so the page's held bytes are reused.
    const [attempt, nextAttempt] = React.useReducer((value: number) => value + 1, 0);
    const preview = useFilePreviewSource({
      ...item.source,
      enabled: picture && item.source.enabled,
      retryCount: (item.source.retryCount ?? 0) + attempt,
    });
    const [size, setSize] = React.useState<MediaPictureSize | null>(null);
    const [failed, setFailed] = React.useState<string | null>(null);
    const [fullResolution, setFullResolution] = React.useState(false);
    const retry = React.useCallback(() => { setFailed(null); nextAttempt(); }, []);
    // The image body's reason and copy (one owner): a load that did not finish offers Retry; a fact about the file
    // (too large, unsupported, missing) stays a quiet line, with Open file where the caller can hand it off.
    const unavailable = preview.status === 'error' || failed
      ? previewUnavailableCard(preview.status === 'error'
        ? resolvePreviewUnavailable({ error: preview.error, errorCode: preview.errorCode, sizeBytes: item.sizeBytes ?? item.source.sizeBytes })
        : { kind: 'loadFailed', error: failed! }, item.title)
      : null;
    const viewportSize = React.useMemo(
      () => ({ width: props.viewport.width, height: props.viewport.height }),
      [props.viewport.width, props.viewport.height],
    );
    // The picture keeps its well's backing (checkerboard for alpha, or the chosen Background), so a
    // dark transparent image stays visible on the dark stage exactly as it was on the page.
    const backing = useImageBacking(item.kind === 'svg' ? 'svg' : 'image', item.alphaCapable === true);
    const pictureSize = size ? fitSize(size, viewportSize) : null;
    const { onSize, onZoomChange, onPage, onDismiss, onTap } = props;
    const index = props.index;
    const reportPreview = React.useCallback((state: FilePreviewSourceState) => props.onPreviewChange(index, state), [index, props.onPreviewChange]);
    const pictureUri = picture && !failed && preview.status === 'loaded' ? preview.uri : null;
    const pictureMime = pictureUri && preview.status === 'loaded' ? preview.mimeType : undefined;
    React.useEffect(() => {
      if (!picture) return;
      reportPreview(pictureUri
        ? { status: 'loaded', uri: pictureUri, error: null, mimeType: pictureMime }
        : { status: 'disabled', uri: null, error: null });
    }, [picture, pictureUri, pictureMime, reportPreview]);

    React.useEffect(() => {
      if (!picture) onSize(index, null);
      else if (preview.status === 'error' || failed) onSize(index, null);
      else if (preview.status === 'loading' || preview.status === 'disabled')
        onSize(index, null);
    }, [failed, index, onSize, picture, preview.status]);
    const handleIntrinsicSize = React.useCallback(
      (next: MediaPictureSize) => {
        setSize((current) =>
          current?.width === next.width && current.height === next.height
            ? current
            : next,
        );
        onSize(index, next);
      },
      [index, onSize],
    );

    const annotating = props.annotator !== null;
    const fingerTaken = useAnnotatorHoldsFinger(props.annotator);
    const hasPrevious = props.index > 0;
    const hasNext = props.index < props.items.length - 1;
    const zoom = useZoomableViewport({
      imageSize: size ?? { width: 0, height: 0 },
      viewportSize,
      reducedMotion: props.reducedMotion,
      hasPrevious,
      hasNext,
      pageGap: theme.space.s24,
      onDismiss: annotating ? () => {} : onDismiss,
      ...(props.items.length > 1 && !annotating
        ? { onPage: (direction: -1 | 1) => onPage(direction) }
        : {}),
      onTap: annotating ? () => {} : onTap,
      onePointerPan: !fingerTaken,
      onZoomSettled: (aboveFit: boolean) => {
        setFullResolution(aboveFit);
        // 100% is one image pixel per device pixel: what the "1" key and a desktop click choose.
        onZoomChange(
          size && aboveFit
            ? Math.round(zoom.scale.value * PixelRatio.get() * 100)
            : null,
        );
      },
      onZoomBoundary: () => {
        void hapticsLight();
      },
    });

    const viewportRef = React.useRef<View>(null);
    useWheelZoom(viewportRef, zoom.wheelHandlers);

    useAnimatedReaction(
      () => zoom.dismissY.value,
      (dy) => {
        props.dragProgress.value = Math.min(
          1,
          Math.abs(dy) / (0.33 * Math.max(1, viewportSize.height)),
        );
      },
      [viewportSize.height],
    );

    React.useImperativeHandle(
      ref,
      () => ({
        visibleFrame: () => {
          if (!size) return null;
          const fitted = fitRect(size, props.viewport);
          const bounds = resolveZoomBounds(size, viewportSize, 1);
          const zoomRatio =
            bounds.min === 0 ? 1 : zoom.scale.value / bounds.min;
          const dismissScale = props.reducedMotion
            ? 1
            : dismissPresentation(zoom.dismissY.value, viewportSize.height)
                .scale;
          const width = fitted.width * zoomRatio * dismissScale;
          const height = fitted.height * zoomRatio * dismissScale;
          const cx =
            props.viewport.x +
            props.viewport.width / 2 +
            zoom.translationX.value * dismissScale +
            zoom.dismissX.value;
          const cy =
            props.viewport.y +
            props.viewport.height / 2 +
            zoom.translationY.value * dismissScale +
            zoom.dismissY.value;
          return { x: cx - width / 2, y: cy - height / 2, width, height };
        },
        zoomIn: zoom.zoomIn,
        zoomOut: zoom.zoomOut,
        fit: zoom.fit,
        actual: zoom.actual,
      }),
      [props.reducedMotion, props.viewport, size, viewportSize, zoom],
    );

    const backdropStyle = useAnimatedStyle(() => ({
      opacity:
        props.progress.value *
        dismissPresentation(zoom.dismissY.value, viewportSize.height).backdrop,
    }));
    const immersiveStyle = useAnimatedStyle(() => ({
      opacity: props.immersive.value,
    }));

    const neighboursEnabled = props.phase === 'open';
    // Annotating holds one picture (paging is off), so its neighbours stay out of the room the steps panel frees.
    const showNeighbours = !annotating;
    const pageOffset = props.viewport.width + theme.space.s24;
    const hidden = props.phase !== 'open' && picture && size !== null;
    const label = itemLabel(item, size);

    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: theme.colors.surface.base },
            backdropStyle,
          ]}
        >
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.colors.overlay.stageImmersive },
              immersiveStyle,
            ]}
          />
        </Animated.View>
        <View
          ref={viewportRef}
          style={[
            stageStyles.viewport,
            {
              left: props.viewport.x,
              top: props.viewport.y,
              width: props.viewport.width,
              height: props.viewport.height,
            },
            props.clip ? stageStyles.clip : null,
          ]}
        >
          {picture ? (
            <GestureDetector gesture={zoom.gesture}>
              <Animated.View
                style={[StyleSheet.absoluteFill, zoom.pageStyle]}
                collapsable={false}
              >
                {hasPrevious && showNeighbours ? (
                  <View
                    style={[
                      StyleSheet.absoluteFill,
                      { transform: [{ translateX: -pageOffset }] },
                    ]}
                  >
                    <NeighbourPicture
                      item={props.items[props.index - 1]!}
                      viewport={props.viewport}
                      enabled={neighboursEnabled}
                    />
                  </View>
                ) : null}
                {hasNext && showNeighbours ? (
                  <View
                    style={[
                      StyleSheet.absoluteFill,
                      { transform: [{ translateX: pageOffset }] },
                    ]}
                  >
                    <NeighbourPicture
                      item={props.items[props.index + 1]!}
                      viewport={props.viewport}
                      enabled={neighboursEnabled}
                    />
                  </View>
                ) : null}
                <Animated.View
                  style={[
                    StyleSheet.absoluteFill,
                    stageStyles.centre,
                    zoom.dismissStyle,
                    hidden ? stageStyles.hidden : null,
                  ]}
                >
                  {preview.status === 'loaded' && !failed ? (
                    <Animated.View
                      // The picture never takes the pointer (a web <img> would start a native image drag);
                      // the viewport's recognizers own every press, pan and pinch. While annotating, only
                      // the canvas laid over it takes the pointer.
                      pointerEvents={annotating ? 'box-none' : 'none'}
                      style={zoom.contentStyle}
                      accessible
                      accessibilityRole="image"
                      accessibilityLabel={label}
                      accessibilityActions={[
                        { name: 'zoomIn', label: t('files.viewer.zoomIn') },
                        { name: 'zoomOut', label: t('files.viewer.zoomOut') },
                        { name: 'fit', label: t('files.viewer.fit') },
                      ]}
                      onAccessibilityAction={(event) => {
                        if (event.nativeEvent.actionName === 'zoomIn') zoom.zoomIn();
                        else if (event.nativeEvent.actionName === 'zoomOut') zoom.zoomOut();
                        else if (event.nativeEvent.actionName === 'fit') zoom.fit();
                      }}
                    >
                      <AnnotatorPictureFrame
                        annotator={props.annotator}
                        size={pictureSize ?? undefined}
                        // A phone insets the picture in its gutter with the media radius and an ink hairline, so a
                        // light picture keeps its edge on a light stage (lab `ia · I1p`).
                        {...(phone ? { radius: theme.borderRadius.lg } : {})}
                        style={[pictureSize, backing.paper ? { backgroundColor: backing.paper } : null,
                          phone ? { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border.default } : null]}
                      >
                        {backing.checkerboard && pictureSize ? (
                          <HappierImageCheckerboard color={theme.colors.text.primary} testID="media-stage-image-checkerboard" />
                        ) : null}
                        <MediaPicture
                          key={attempt}
                          kind={item.kind === 'svg' ? 'svg' : 'image'}
                          // Reopened marks stand on the original, not on the picture they were burned into.
                          uri={props.annotator?.source.uri ?? preview.uri}
                          size={pictureSize}
                          onIntrinsicSize={handleIntrinsicSize}
                          onError={setFailed}
                          fullResolution={fullResolution}
                          // Pictures already fitting at 1× enlarge their pixels, not a downsampled photograph.
                          pixelated={item.kind === 'image' && fullResolution && size !== null
                            && resolveZoomBounds(size, viewportSize, PixelRatio.get()).min === 1}
                          testID="media-stage-image"
                        />
                        {props.annotator ? <AnnotatorCanvas annotator={props.annotator} /> : null}
                      </AnnotatorPictureFrame>
                    </Animated.View>
                  ) : unavailable ? (
                    <SurfaceStateCard
                      kind={unavailable.kind}
                      size="pane"
                      title={unavailable.title}
                      {...(unavailable.reason ? { reason: unavailable.reason } : {})}
        {...(unavailable.iconName ? { iconName: unavailable.iconName } : {})}
                      {...(unavailable.diagnosticCode ? { diagnosticCode: unavailable.diagnosticCode } : {})}
                      {...(unavailable.retryable
                        ? {
                            action: { label: t('common.retry'), onPress: retry, testID: 'media-stage-retry' },
                            ...(item.openFile ? { secondaryAction: { label: t('files.viewer.openFile'), onPress: item.openFile } } : {}),
                          }
                        : item.openFile
                          ? { action: { label: t('files.viewer.openFile'), onPress: item.openFile } }
                          : {})}
                    />
                  ) : (
                    <ActivitySpinner
                      size="small"
                      color={theme.colors.text.secondary}
                    />
                  )}
                </Animated.View>
              </Animated.View>
            </GestureDetector>
          ) : (
            <View style={StyleSheet.absoluteFill}>
              <StageDocumentItem item={item} isActive={props.phase === 'open'}
                onPreviewChange={reportPreview}
                onVideoControls={props.onVideoControls}
                onDownload={props.onDownload}
                onOpenInDefaultApp={props.onOpenInDefaultApp} />
            </View>
          )}
        </View>
      </View>
    );
  },
);

const loadStageMediaPlayer = () =>
  import('@/components/workspaces/files/file/MediaPlayerBody').then((module) => module.MediaPlayerBody);
const loadStagePdfViewer = () => import('../pdf/PdfViewer').then((module) => module.PdfViewer);

/**
 * A phone's annotate dock by the thumb: the numbered steps above the palette rows (lab `comments` A, 390). It
 * rides above the keyboard while a note is typed, and tells the stage how much room it takes from the bottom.
 */
function StagePhoneAnnotateDock(props: Readonly<{
  annotator: ImageAnnotator;
  steps: boolean;
  stepsMaxHeight: number;
  onRoom: (room: number) => void;
}>) {
  const { theme } = useUnistyles();
  const insets = useChromeSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const bottom = Math.max(insets.bottom, keyboardHeight) + theme.space.s16;
  const { onRoom } = props;
  // The room reported to the stage holds the steps panel at its full height from the first step on, so the
  // picture stays still while rows arrive and taps land where they were aimed.
  const sizes = React.useRef({ dock: 0, steps: 0 });
  const report = () => {
    const stepsReserve = props.steps ? props.stepsMaxHeight + theme.space.s12 * 2 : 0;
    onRoom(sizes.current.dock + bottom + (props.steps ? Math.max(0, stepsReserve - sizes.current.steps) : 0));
  };
  return (
    <Animated.View
      entering={FadeIn.duration(motionTokens.guardMoment.wordCrossFadeMs)}
      exiting={FadeOut.duration(motionTokens.durationMs.fast)}
      style={[stageStyles.phonePaletteLayer, { bottom }]}
      pointerEvents="box-none"
      onLayout={(event) => { sizes.current.dock = event.nativeEvent.layout.height; report(); }}
    >
      {props.steps ? (
        <View onLayout={(event) => { sizes.current.steps = event.nativeEvent.layout.height; report(); }}>
          <GlassPanel radius={theme.space.s16} shadowLevel={2} innerShadow={false} style={stageStyles.phoneSteps}>
            <ScrollView style={{ maxHeight: props.stepsMaxHeight }} keyboardShouldPersistTaps="handled">
              <AnnotatorSteps annotator={props.annotator} presentation="list" />
            </ScrollView>
          </GlassPanel>
        </View>
      ) : null}
      <AnnotatorPalette annotator={props.annotator} layout="phone" surface="glass" />
    </Animated.View>
  );
}

/** Video and PDF items render their own bodies in the stage (lab MS1f); pictures use the zoom viewport. */
function StageDocumentItem(props: Readonly<{
  item: MediaStageItem;
  isActive: boolean;
  onPreviewChange: (preview: FilePreviewSourceState) => void;
  onDownload?: () => void;
  onOpenInDefaultApp?: () => void;
  onVideoControls?: (controls: MediaPlayerVideoControls | null) => void;
}>) {
  // Full screen shows the whole page first (lab MS1f); the zoom menu and pinch take it closer.
  const [zoom, setZoom] = React.useState<PdfZoom>('fit-page');
  if (props.item.kind === 'video') {
    return (
      <SessionPaneLazyLoader<MediaPlayerBodyProps>
        testID="media-stage-video"
        load={loadStageMediaPlayer}
        props={{ kind: 'video', title: props.item.title, source: props.item.source, isActive: props.isActive,
          onPreviewChange: props.onPreviewChange, onVideoControls: props.onVideoControls,
          onDownload: props.onDownload, onOpenInDefaultApp: props.onOpenInDefaultApp }}
      />
    );
  }
  return (
    <SessionPaneLazyLoader<PdfViewerProps>
      testID="media-stage-pdf"
      load={loadStagePdfViewer}
      props={{
        title: props.item.title,
        source: props.item.source,
        isActive: props.isActive,
        findSurfaceId: 'media-stage-pdf',
        presentation: 'stage',
        zoom,
        onZoomChange: setZoom,
        onPreviewChange: props.onPreviewChange,
        onOpenInDefaultApp: props.onOpenInDefaultApp,
      }}
    />
  );
}

function StageCapsule(props: Readonly<{ children: React.ReactNode }>) {
  return (
    <GlassPanel shadowLevel={2} innerShadow={false} style={stageStyles.capsule}>
      {props.children}
    </GlassPanel>
  );
}

/**
 * A phone's strip (lab pr974 ST1): neighbours narrow, the current one wide and always centred, above the bottom bar
 * in thumb reach. Its cells have two widths, so the list's layout reads them from here.
 */
const PHONE_STRIP = { narrow: 28, narrowHeight: 40, wide: 62, wideHeight: 44, gap: 2, wideMargin: 6 } as const;
const PHONE_NARROW_STRIDE = PHONE_STRIP.narrow + PHONE_STRIP.gap;
const PHONE_WIDE_STRIDE = PHONE_STRIP.wide + PHONE_STRIP.gap + PHONE_STRIP.wideMargin * 2;

/** Where a strip cell stands: wide-stride squares on wide screens; on a phone the current cell is the wide one. */
export function resolveStageStripCellLayout(index: number, current: number, phone: boolean, stride: number,
  phoneInset = 0): Readonly<{ length: number; offset: number }> {
  if (!phone) return { length: stride, offset: stride * index };
  return {
    length: index === current ? PHONE_WIDE_STRIDE : PHONE_NARROW_STRIDE,
    offset: phoneInset + PHONE_NARROW_STRIDE * index + (index > current ? PHONE_WIDE_STRIDE - PHONE_NARROW_STRIDE : 0),
  };
}

function StripThumb(
  props: Readonly<{
    item: MediaStageItem;
    selected: boolean;
    enabled: boolean;
    onPress: () => void;
    label: string;
    phone: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const picture = isPicture(props.item);
  const preview = useFilePreviewSource({
    ...props.item.source,
    enabled: props.enabled && picture && props.item.source.enabled,
    cacheOnly: true,
  });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      style={[
        stageStyles.thumb,
        props.phone ? (props.selected ? stageStyles.phoneThumbWide : stageStyles.phoneThumb) : null,
        props.selected ? { borderColor: theme.colors.border.focus } : null,
      ]}
    >
      <View style={[stageStyles.thumbInner, props.phone ? stageStyles.phoneThumbInner : null]}>
        {picture && preview.status === 'loaded' ? (
          <MediaPicture
            kind={props.item.kind === 'svg' ? 'svg' : 'image'}
            uri={preview.uri}
            size={props.phone
              ? { width: props.selected ? PHONE_STRIP.wide : PHONE_STRIP.narrow, height: props.selected ? PHONE_STRIP.wideHeight : PHONE_STRIP.narrowHeight }
              : { width: STRIP_THUMB_SIZE, height: STRIP_THUMB_SIZE }}
                    fit="cover"
            style={stageStyles.thumbImage}
          />
        ) : (
          <Icon
            name={
              props.item.kind === 'video'
                ? 'video-camera'
                : props.item.kind === 'pdf'
                  ? 'file-text'
                  : 'image'
            }
            size={props.phone ? 14 : 20}
            color={theme.colors.text.secondary}
          />
        )}
      </View>
    </Pressable>
  );
}

/** Every item remains scrollable; only visible cells observe and decode already held preview bytes. */
function StageGalleryStrip(props: Readonly<{
  items: readonly MediaStageItem[];
  index: number;
  enabled: boolean;
  width: number;
  phone: boolean;
  onSelect: (index: number) => void;
}>) {
  const { theme } = useUnistyles();
  const list = React.useRef<FlatList<MediaStageItem>>(null);
  const [visible, setVisible] = React.useState<ReadonlySet<number>>(() => new Set());
  const onViewableItemsChanged = React.useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const next = new Set(viewableItems.flatMap(item => item.isViewable && item.index !== null ? [item.index] : []));
    setVisible(current => current.size === next.size && [...next].every(index => current.has(index)) ? current : next);
  }, []);
  React.useEffect(() => { list.current?.scrollToIndex({ index: props.index, viewPosition: 0.5, animated: false }); }, [props.index]);
  const extraData = React.useMemo(() => ({ index: props.index, enabled: props.enabled, visible }), [props.index, props.enabled, visible]);
  const stride = STRIP_THUMB_SIZE + theme.space.s4;
  const { phone, index: current } = props;
  const phoneInset = phone ? Math.max(0, (props.width - PHONE_WIDE_STRIDE) / 2) : 0;
  // The first open lands the current cell in the middle (lab ST1p): its centred offset once the strip has laid out.
  const placed = React.useRef(false);
  const placeCurrent = React.useCallback(() => {
    if (!phone || placed.current) return;
    placed.current = true;
    list.current?.scrollToOffset({ offset: PHONE_NARROW_STRIDE * current, animated: false });
  }, [current, phone]);
  return <FlatList
    ref={list}
    testID="media-stage-gallery"
    horizontal
    data={props.items}
    extraData={extraData}
    initialScrollIndex={props.index}
    initialNumToRender={Math.max(1, Math.ceil(props.width / (phone ? PHONE_NARROW_STRIDE : stride)))}
    getItemLayout={(_items, index) => ({ ...resolveStageStripCellLayout(index, current, phone, stride, phoneInset), index })}
    // A phone keeps the current cell centred at either end too (lab pr974 ST1p): half the strip of room before and after.
    {...(phone ? { ListHeaderComponent: <View style={{ width: phoneInset }} />, ListFooterComponent: <View style={{ width: phoneInset }} /> } : {})}
    keyExtractor={(_item, index) => String(index)}
    onViewableItemsChanged={onViewableItemsChanged}
    onContentSizeChange={placeCurrent}
    style={{ maxWidth: props.width }}
    contentContainerStyle={phone ? stageStyles.phoneStripRow : stageStyles.stripRow}
    accessibilityRole="tablist"
    accessibilityLabel={t('files.viewer.stageGallery', { count: props.items.length })}
    renderItem={({ item, index }) => <StripThumb item={item} selected={index === props.index}
      enabled={props.enabled && visible.has(index)} label={item.title} phone={phone} onPress={() => props.onSelect(index)} />}
  />;
}

/**
 * The Media stage (P2 §3.4, lab files MS1): one full-screen layer for every image, SVG, PDF and video.
 * The picture flies from its thumbnail onto the page colour, zooms about the focal point, pages through a
 * frozen gallery and drags back home. The modal owner keeps focus trap, portal and focus return.
 */
export function MediaStage(props: MediaStageProps & CustomModalInjectedProps) {
  const { theme } = useUnistyles();
  const gallery = useMediaStageGallery(props.items, props.initialIndex);
  const window = usePresentationWindowDimensions();
  const insets = useChromeSafeAreaInsets();
  const phone = useDeviceType() === 'phone';
  const reducedMotion = useReducedMotionPreference();
  const [phase, setPhase] = React.useState<Phase>('opening');
  const [immersive, setImmersive] = React.useState(false);
  const [zoomPercent, setZoomPercent] = React.useState<number | null>(null);
  const [heldPreview, setHeldPreview] = React.useState<Readonly<{ index: number; uri: string; mimeType?: string }> | null>(null);
  const handlePreviewChange = React.useCallback((index: number, state: FilePreviewSourceState) => {
    setHeldPreview(current => {
      const uri = state.status === 'loaded' ? state.uri : null;
      if (uri === null) return current?.index === index ? null : current;
      const mimeType = state.status === 'loaded' ? state.mimeType : undefined;
      return current?.index === index && current.uri === uri && current.mimeType === mimeType ? current : { index, uri, mimeType };
    });
  }, []);
  const [flightSize, setFlightSize] = React.useState<MediaPictureSize | null>(
    null,
  );
  const sizes = React.useRef(new Map<number, MediaPictureSize | null>());
  const viewerRef = React.useRef<ViewerHandle>(null);
  const flip = useRectFlip({ initialProgress: 0 });
  const dragProgress = useSharedValue(0);
  const immersiveValue = useSharedValue(0);
  const chromeValue = useSharedValue(0);
  const opened = React.useRef(false);
  const closeRequested = React.useRef(false);
  const cancelCloseMeasurement = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => cancelCloseMeasurement.current?.(), []);
  // A paused video frame is marked as a picture in its video's place (platform lab `media`): the frame holds
  // the slot until Done, Cancel or its copy lands in a Session, then the video returns at that moment.
  const [heldFrame, setHeldFrame] = React.useState<Readonly<{ index: number; frame: MediaPlayerFrame; item: MediaStageItem }> | null>(null);
  const [videoControls, setVideoControls] = React.useState<MediaPlayerVideoControls | null>(null);
  const resumeAt = React.useRef<number | null>(null);
  const handleVideoControls = React.useCallback((controls: MediaPlayerVideoControls | null) => {
    setVideoControls(controls);
    if (controls && resumeAt.current !== null) { controls.seekTo(resumeAt.current); resumeAt.current = null; }
  }, []);
  const activeFrame = heldFrame?.index === gallery.index ? heldFrame : null;
  const item = activeFrame?.item ?? gallery.currentItem;
  const stageItems = React.useMemo(() => heldFrame
    ? gallery.items.map((entry, index) => (index === heldFrame.index ? heldFrame.item : entry)) : gallery.items, [gallery.items, heldFrame]);
  const multiple = gallery.items.length > 1;
  // Every multi-item gallery shows where you are in it, on phones too (lab pr974 ST1).
  const showStrip = multiple;
  // The active viewer holds these bytes for its lifetime; flight and Save follow that exact preview, including Retry.
  const currentPreview = heldPreview?.index === gallery.index ? heldPreview : null;


  // Annotate mode (P2 D6, MIS §8). `useMediaStageAnnotation` owns entering, Cancel's question and Done;
  // the annotator itself mounts only while a session is open, so a stage that never annotates does no
  // annotation work (S4).
  const stageAnnotation = useMediaStageAnnotation(item);
  const [annotator, setAnnotator] = React.useState<ImageAnnotator | null>(null);
  const annotation = stageAnnotation.session && annotator ? { annotator } : null;
  // Numbered steps open their list beside the picture (wide) or above the phone palette; the picture's
  // viewport makes room for it so no step sits under its own list.
  const stepsShown = useAnnotatorShowsSteps(annotation?.annotator ?? null) && !immersive;
  // The phone dock (steps over the palette) reports the room it takes from the bottom, keyboard included.
  const [phoneDockRoom, setPhoneDockRoom] = React.useState(0);

  const windowRect = React.useMemo<Rect>(
    () => ({ x: 0, y: 0, width: window.width, height: window.height }),
    [window.width, window.height],
  );
  const viewport = React.useMemo<Rect>(() => {
    if (immersive) return windowRect;
    // A phone keeps a side gutter, so a picture's edge is out of the screen edge's gesture (lab `ia · I1p`).
    if (phone) {
      const height = stepsShown && phoneDockRoom > 0 ? window.height - phoneDockRoom - theme.space.s8 : window.height;
      return { ...windowRect, x: theme.space.s16, width: Math.max(1, window.width - theme.space.s16 * 2), height: Math.max(1, height) };
    }
    const top = theme.space.s12 + TOP_BAR_HEIGHT + theme.space.s16;
    const bottom = showStrip
      ? theme.space.s16 * 2 + STRIP_THUMB_SIZE + theme.space.s4 * 2
      : top;
    const side = theme.space.s32;
    const steps = stepsShown ? STEPS_PANEL_WIDTH + side : 0;
    return {
      x: side,
      y: top,
      width: Math.max(1, window.width - side * 2 - steps),
      height: Math.max(1, window.height - top - bottom),
    };
  }, [
    immersive,
    phone,
    phoneDockRoom,
    showStrip,
    stepsShown,
    theme.space,
    window.height,
    window.width,
    windowRect,
  ]);

  const [reverted, setReverted] = React.useState(false);
  const annotateCapsule: StageAnnotateCapsule = stageAnnotation.confirmDiscard ? 'confirmDiscard' : reverted ? 'reverted' : 'editing';
  const setAnnotateCapsule = React.useCallback((next: StageAnnotateCapsule) => {
    if (next === 'editing') stageAnnotation.keepEditing();
    setReverted(next === 'reverted');
  }, [stageAnnotation]);
  const capsuleLayout = useStageCapsuleLayout();
  // Every picture: Done lands in place where the picture is editable, as a copy in a draft elsewhere (P2 U4).
  const pictureAnnotatable = isPicture(item) && currentPreview !== null && phase === 'open'
    && (!activeFrame || currentPreview.uri === activeFrame.frame.uri);
  const frameAnnotatable = item.kind === 'video' && videoControls !== null && phase === 'open';
  const annotatable = pictureAnnotatable || frameAnnotatable;
  // Reading a paused frame can take seconds on a long video: the entry shows progress and ignores a second press.
  const [readingFrame, setReadingFrame] = React.useState(false);
  const readingFrameRef = React.useRef(false);
  const annotateFrame = React.useCallback(async () => {
    if (!videoControls || item.kind !== 'video' || readingFrameRef.current) return;
    readingFrameRef.current = true;
    setReadingFrame(true);
    videoControls.playback?.pause();
    const frame = await videoControls.readFrame().catch(() => null);
    readingFrameRef.current = false;
    setReadingFrame(false);
    if (!frame) return;
    const frameTime = formatPlaybackTime(frame.timeSeconds);
    setHeldFrame({ index: gallery.index, frame, item: {
      kind: 'image', title: `${item.title} · ${frameTime}`, source: { enabled: true, source: { kind: 'uri', uri: frame.uri } },
      annotate: true, frameTime, ...(item.targetSession ? { targetSession: item.targetSession } : {}) } });
  }, [gallery.index, item, videoControls]);
  const enterAnnotate = React.useCallback(() => {
    if (frameAnnotatable) { void annotateFrame(); return; }
    const size = activeFrame?.frame ?? sizes.current.get(gallery.index);
    if (!pictureAnnotatable || !size || !currentPreview) return;
    setImmersive(false);
    setReverted(false);
    void stageAnnotation.enter({ uri: currentPreview.uri, width: size.width, height: size.height });
  }, [activeFrame, annotateFrame, currentPreview, frameAnnotatable, gallery.index, pictureAnnotatable, stageAnnotation]);
  // Tray "Edit marks" (and a held video frame) opens straight into Annotate, once per item.
  const autoAnnotated = React.useRef<MediaStageItem | null>(null);
  React.useEffect(() => {
    // A decoded frame already has its dimensions. The image's later onLoad updates only the size ref.
    if (!item.annotate || autoAnnotated.current === item || !pictureAnnotatable || (!activeFrame && !sizes.current.get(gallery.index))) return;
    autoAnnotated.current = item;
    enterAnnotate();
  }, [activeFrame, enterAnnotate, gallery.index, item, pictureAnnotatable]);
  // The held frame gives its slot back once its annotate session has ended (Done, Cancel or the copy landed).
  const frameAnnotated = React.useRef(false);
  React.useEffect(() => {
    if (!heldFrame) { frameAnnotated.current = false; return; }
    if (stageAnnotation.session) { frameAnnotated.current = true; return; }
    if (frameAnnotated.current && !stageAnnotation.choosingSession) {
      resumeAt.current = heldFrame.frame.timeSeconds;
      setHeldFrame(null);
    }
  }, [heldFrame, stageAnnotation.choosingSession, stageAnnotation.session]);
  const cancelAnnotate = React.useCallback(() => {
    if (annotator) stageAnnotation.cancel(annotator.store.getState().document);
  }, [annotator, stageAnnotation]);

  React.useEffect(() => {
    immersiveValue.value = withTiming(immersive ? 1 : 0, {
      duration: reducedMotion
        ? motionTokens.durationMs.fast
        : motionTokens.durationMs.base,
      easing: reanimatedMotionTokens.easing.standard,
    });
  }, [immersive, immersiveValue, reducedMotion]);
  const [flightStarted, setFlightStarted] = React.useState(false);
  React.useEffect(() => {
    if (flightStarted && phase !== 'closing' && !immersive) {
      const fadeIn = withTiming(1, { duration: motionTokens.durationMs.fast });
      chromeValue.value =
        phase === 'opening' && !reducedMotion
          ? withDelay(motionTokens.mediaStage.chromeDelayMs, fadeIn)
          : fadeIn;
    } else {
      chromeValue.value = withTiming(0, {
        duration: motionTokens.durationMs.fast,
      });
    }
  }, [chromeValue, flightStarted, immersive, phase, reducedMotion]);

  // From the first flight frame until the stage unmounts, the current item's thumbnail slot is empty.
  React.useLayoutEffect(() => {
    const node = flightStarted ? item.originRef?.current : null;
    return node ? hideStageOrigin(node) : undefined;
  }, [flightStarted, item.originRef]);

  const finishOpen = React.useCallback(
    () => setPhase((current) => (current === 'opening' ? 'open' : current)),
    [],
  );

  const handleSize = React.useCallback(
    (index: number, size: MediaPictureSize | null) => {
      sizes.current.set(index, size);
      if (closeRequested.current || opened.current || index !== gallery.index) return;
      opened.current = true;
      const target = size ? fitRect(size, viewport) : viewport;
      setFlightSize(size);
      if (!size || reducedMotion) {
        flip.openFrom(null, target, finishOpen);
        setFlightStarted(true);
        return;
      }
      void measureOrigin(item).then((origin) => {
        if (closeRequested.current) return;
        flip.openFrom(
          origin ? coverRectFlipOrigin(origin, size) : null,
          target,
          finishOpen,
        );
        setFlightStarted(true);
      });
    },
    [finishOpen, flip, gallery.index, item, reducedMotion, viewport],
  );

  const close = React.useCallback(
    (velocityY?: number) => {
      if (closeRequested.current) return;
      closeRequested.current = true;
      const size = sizes.current.get(gallery.index) ?? null;
      const frame =
        phase === 'open' ? (viewerRef.current?.visibleFrame() ?? null) : null;
      if (frame) {
        flip.from.value = rectFlipFrame(frame);
        flip.to.value = rectFlipFrame(frame);
      }
      setFlightSize(frame && size ? size : null);
      setPhase('closing');
      const run = (origin: Rect | null) =>
        flip.closeTo(
          origin && size ? coverRectFlipOrigin(origin, size) : null,
          {
            ...(velocityY !== undefined ? { velocityY } : {}),
            onComplete: props.onClose,
          },
        );
      if (!size || reducedMotion) run(null);
      else {
        let settled = false;
        const finishMeasurement = (origin: Rect | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cancelCloseMeasurement.current = null;
          run(origin);
        };
        // A missing native layout callback must not hold Close beyond the owner's flight duration.
        // A timely reply keeps the existing geometry and motion; expiry uses its no-origin departure.
        const timer = setTimeout(() => finishMeasurement(null), ENTER_FROM_RECT_MS);
        cancelCloseMeasurement.current = () => { settled = true; clearTimeout(timer); };
        void measureOrigin(item).then(finishMeasurement);
      }
    },
    [flip, gallery.index, item, phase, props.onClose, reducedMotion],
  );

  // Done lands in the composer (MIS §8.2): the stage flies home and the tray shows the marked picture.
  const doneAnchorRef = React.useRef<View>(null);
  const copyToChosenSession = React.useCallback((address: SessionAddress) => {
    void stageAnnotation.copyToSession(address).then((landed) => {
      if (landed) close();
      else stageAnnotation.cancelCopy();
    });
  }, [close, stageAnnotation]);
  const finishAnnotate = React.useCallback(() => {
    if (!annotator) return;
    void stageAnnotation.done(annotator.store.getState().document).then((landed) => {
      if (landed) close();
    });
  }, [annotator, close, stageAnnotation]);

  // The stage's popovers and the annotator's selection and crop sit in this scope, so they answer Esc first.
  const escapeScope = useEscapeLayer({
    priority: ESCAPE_LAYER_PRIORITIES.modal,
    allowEditableTarget: true,
    onEscape: () => {
      // Esc first brings the controls back, then closes (the keyboard path out of immersive). While
      // annotating it is Cancel (MIS §8.3/8.4).
      if (annotation) cancelAnnotate();
      else if (immersive) setImmersive(false);
      else close();
      return true;
    },
  });

  const goTo = React.useCallback(
    (next: number) => {
      if (next < 0 || next >= gallery.items.length || next === gallery.index)
        return;
      gallery.select(next);
      setHeldPreview(null);
      setZoomPercent(null);
      dragProgress.value = 0;
      const nextItem = gallery.items[next]!;
      announceAccessibilityMessage(
        `${nextItem.title}, ${t('files.viewer.stageCounter', { current: next + 1, total: gallery.items.length })}`,
      );
    },
    [dragProgress, gallery],
  );

  useMediaStageKeyboard(
    phase !== 'closing'
      ? {
          previous: () => { if (!annotation) goTo(gallery.index - 1); },
          next: () => { if (!annotation) goTo(gallery.index + 1); },
          zoomIn: () => viewerRef.current?.zoomIn(),
          zoomOut: () => viewerRef.current?.zoomOut(),
          fit: () => viewerRef.current?.fit(),
          actualSize: () => viewerRef.current?.actual(),
          ...(annotatable && !annotation ? { annotate: enterAnnotate } : {}),
        }
      : null,
  );

  const chromeStyle = useAnimatedStyle(() => ({
    opacity: chromeValue.value * Math.max(0, 1 - dragProgress.value * 4),
  }));
  const chromeInteractive = phase === 'open' && !immersive;
  const counter = multiple
    ? t('files.viewer.stageCounter', {
        current: gallery.index + 1,
        total: gallery.items.length,
      })
    : null;

  const flightTarget = flightSize ? fitRect(flightSize, viewport) : null;
  const flightItem = item;
  const savable = currentPreview?.uri ?? null;
  const handoffMime = currentPreview?.mimeType;
  const handoff = React.useCallback((action?: 'open') => {
    if (!savable) return;
    void saveFileUri({ uri: savable, fileName: item.title, action,
      ...(item.source.source.kind === 'resource' ? { isCurrent: item.source.source.lifetime.isCurrent } : {}),
      mimeType: resolveFileViewerKind({ path: item.title, mimeType: handoffMime ?? item.source.mimeType }).mimeType })
      .catch(error => Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.operationFailed')));
  }, [handoffMime, item, savable]);
  const save = React.useCallback(() => handoff(), [handoff]);
  const openInDefaultApp = React.useCallback(() => handoff('open'), [handoff]);
  const toggleImmersive = React.useCallback(() => setImmersive(value => !value), []);
  const canPrevious = gallery.index > 0;
  const canNext = gallery.index < gallery.items.length - 1;
  // A pointer click zooms, so pointer people reach immersive through this control (lab MS1i).
  const immersiveControl = !phone && isPicture(item);


  const topInset = phone ? insets.top + theme.space.s6 : theme.space.s12;

  // The stage's capsules and strip float over the pictures and pages it shows (arbitrary pixels), so the glass
  // takes the live-picture coat there: a white page under dark ink stays readable at the default.
  return (
    <EscapeLayerProvider layer={escapeScope}>
    <GlassLivePictureBackdropContext.Provider value>
    <View
      style={StyleSheet.absoluteFill}
      accessibilityViewIsModal
      onAccessibilityEscape={() => close()}
      testID="media-stage"
    >
      <StageViewer
        key={gallery.index}
        ref={viewerRef}
        items={stageItems}
        index={gallery.index}
        viewport={viewport}
        window={windowRect}
        phase={phase}
        reducedMotion={reducedMotion}
        progress={flip.progress}
        dragProgress={dragProgress}
        immersive={immersiveValue}
        onSize={handleSize}
        onPage={(direction) => goTo(gallery.index + direction)}
        onDismiss={(velocityY) => close(velocityY)}
        onTap={toggleImmersive}
        onPreviewChange={handlePreviewChange}
        {...(savable ? { onDownload: save } : {})}
        {...(savable && canOpenFileInDefaultApp() ? { onOpenInDefaultApp: openInDefaultApp } : {})}
        onZoomChange={setZoomPercent}
        annotator={annotation?.annotator ?? null}
        onVideoControls={handleVideoControls}
        clip={zoomPercent !== null && !phone && !immersive}
        {...(item.openFile ? { onOpenFile: item.openFile } : {})}
      />

      {stageAnnotation.session ? (
        <StageAnnotatorMount session={stageAnnotation.session} onAnnotator={setAnnotator} />
      ) : null}
      {stageAnnotation.choosingSession ? (
        <StageCopyChooser
          anchorRef={doneAnchorRef}
          targetSession={stageAnnotation.targetSession}
          onChoose={copyToChosenSession}
          onClose={stageAnnotation.cancelCopy}
        />
      ) : null}
      {phase !== 'open' && flightTarget && isPicture(flightItem) && currentPreview ? (
        <Animated.View pointerEvents="none" style={flip.clipStyle}>
          <Animated.View
            style={[
              { width: flightTarget.width, height: flightTarget.height },
              flip.clippedImageStyle,
            ]}
          >
            <MediaPicture
              kind={flightItem.kind === 'svg' ? 'svg' : 'image'}
              uri={currentPreview.uri}
              size={{ width: flightTarget.width, height: flightTarget.height }}
            />
          </Animated.View>
        </Animated.View>
      ) : null}

      <Animated.View
        pointerEvents={chromeInteractive ? 'box-none' : 'none'}
        style={[StyleSheet.absoluteFill, chromeStyle]}
      >
        <View
          style={[
            stageStyles.topBar,
            { top: topInset, left: theme.space.s12, right: theme.space.s12 },
          ]}
          pointerEvents="box-none"
        >
          <StageCapsule>
            <IconButton
              variant="plain"
              iconName="x"
              accessibilityLabel={annotation ? t('common.cancel') : t('common.close')}
              tooltip={annotation ? t('common.cancel') : t('common.close')}
              onPress={() => (annotation ? cancelAnnotate() : close())}
              testID="media-stage-close"
            />
          </StageCapsule>
          {annotation ? (
            <View style={stageStyles.titleSpacer} pointerEvents="none" />
          ) : (
            <View style={stageStyles.title} pointerEvents="none">
              <View style={{ minWidth: 0, flexShrink: 1 }}>
              <Text
                variant="body"
                emphasis="semiBold"
                numberOfLines={1}
                style={{ color: theme.colors.text.primary, flexShrink: 1 }}
              >
                {item.title}
              </Text>
              {item.subtitle ? (
                <Text variant="meta" style={{ color: theme.colors.text.secondary }} numberOfLines={2}>
                  {item.subtitle}
                </Text>
              ) : null}
              </View>
              {counter && !phone ? (
                <Text
                  variant="body"
                  style={[
                    { color: theme.colors.text.secondary },
                    Typography.tabular(),
                  ]}
                >
                  {counter}
                </Text>
              ) : null}
            </View>
          )}
          {annotation || zoomPercent !== null || item.openFile || item.showInChat || savable || immersiveControl || annotatable ? (
            // One capsule that reshapes on the travel spring between viewing and annotating (MIS §8.1).
            <Animated.View layout={capsuleLayout}>
            <StageCapsule>
              {annotation ? (
                <StageAnnotateActions
                  annotator={annotation.annotator}
                  capsule={annotateCapsule}
                  onCapsule={setAnnotateCapsule}
                  done={{ busy: stageAnnotation.pending, onPress: finishAnnotate, anchorRef: doneAnchorRef }}
                  onDiscard={stageAnnotation.discard}
                  phone={phone}
                />
              ) : (
              <>
              {item.showInChat && !phone ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={item.showInChat}
                  style={stageStyles.capsuleLabelButton}
                  testID="media-stage-show-in-chat"
                >
                  <Icon name="chat-circle" size={16} color={theme.colors.text.primary} />
                  <Text variant="body" emphasis="medium" style={{ color: theme.colors.text.primary }}>
                    {t('files.pane.gallery.showInChat')}
                  </Text>
                </Pressable>
              ) : null}
              {annotatable && !phone ? (
                <StageAnnotateEntry
                  tooltip={t('files.annotate.annotate')}
                  onPress={enterAnnotate}
                  busy={readingFrame}
                />
              ) : null}
              {zoomPercent !== null && !phone ? (
                <>
                  <IconButton
                    variant="plain"
                    iconName="minus"
                    accessibilityLabel={t('files.viewer.zoomOut')}
                    tooltip={t('files.viewer.zoomOut')}
                    onPress={() => viewerRef.current?.zoomOut()}
                  />
                  <Text
                    variant="meta"
                    style={[
                      stageStyles.zoomLabel,
                      { color: theme.colors.text.primary },
                      Typography.tabular(),
                    ]}
                  >
                    {t('files.viewer.zoomPercent', { percent: zoomPercent })}
                  </Text>
                  <IconButton
                    variant="plain"
                    iconName="plus"
                    accessibilityLabel={t('files.viewer.zoomIn')}
                    tooltip={t('files.viewer.zoomIn')}
                    onPress={() => viewerRef.current?.zoomIn()}
                  />
                </>
              ) : null}
              {savable ? (
                <IconButton
                  variant="plain"
                  iconName={Platform.OS === 'web' ? 'download' : 'share'}
                  accessibilityLabel={Platform.OS === 'web' ? t('files.viewer.download') : t('files.viewer.share')}
                  tooltip={Platform.OS === 'web' ? t('files.viewer.download') : t('files.viewer.share')}
                  onPress={save}
                  testID="media-stage-save"
                />
              ) : null}
              {item.openFile && !phone ? (
                <IconButton
                  variant="plain"
                  iconName="arrow-square-out"
                  accessibilityLabel={t('files.viewer.openFile')}
                  tooltip={t('files.viewer.openFile')}
                  onPress={item.openFile}
                  testID="media-stage-open-file"
                />
              ) : null}
              {immersiveControl ? (
                <IconButton
                  variant="plain"
                  iconName="arrows-out"
                  accessibilityLabel={t('files.viewer.hideControls')}
                  tooltip={t('files.viewer.hideControls')}
                  onPress={toggleImmersive}
                  testID="media-stage-immersive"
                />
              ) : null}
              </>
              )}
            </StageCapsule>
            </Animated.View>
          ) : (
            <View style={stageStyles.capsulePlaceholder} />
          )}
        </View>
        {annotation && phone ? (
          <StagePhoneAnnotateDock annotator={annotation.annotator} steps={stepsShown}
            stepsMaxHeight={window.height / 3} onRoom={setPhoneDockRoom} />
        ) : null}
        {annotation && !phone ? (
          <Animated.View
            entering={FadeIn.duration(motionTokens.guardMoment.wordCrossFadeMs)}
            exiting={FadeOut.duration(motionTokens.durationMs.fast)}
            style={[
              stageStyles.paletteLayer,
              { top: topInset, left: theme.space.s12, right: theme.space.s12 },
            ]}
          >
            <AnnotatorPalette annotator={annotation.annotator} layout="bar" surface="glass" />
          </Animated.View>
        ) : null}
        {annotation && !phone && stepsShown ? (
          <Animated.View
            entering={FadeIn.duration(motionTokens.guardMoment.wordCrossFadeMs)}
            exiting={FadeOut.duration(motionTokens.durationMs.fast)}
            style={[stageStyles.stepsLayer, { top: viewport.y, right: theme.space.s32, maxHeight: viewport.height }]}
          >
            <GlassPanel radius={theme.space.s16} shadowLevel={2} innerShadow={false}>
              <ScrollView keyboardShouldPersistTaps="handled">
                <AnnotatorSteps annotator={annotation.annotator} presentation="panel" />
              </ScrollView>
            </GlassPanel>
          </Animated.View>
        ) : null}

        {showStrip && !annotation && !(phone && immersive) ? (
          <Animated.View
            entering={FadeIn.duration(motionTokens.overlay.panel.enterMs)}
            exiting={FadeOut.duration(reducedMotion ? motionTokens.overlay.panel.reducedMotionFadeMs : motionTokens.overlay.panel.exitMs)}
            style={[stageStyles.stripDock, { bottom: phone ? insets.bottom + theme.space.s24 + TOP_BAR_HEIGHT + theme.space.s12 : theme.space.s16 }]}
            pointerEvents="box-none"
          >
            {phone ? (
              <StageGalleryStrip items={gallery.items} index={gallery.index} enabled={phase === 'open'} phone
                width={window.width} onSelect={goTo} />
            ) : (
              <GlassPanel
                radius={theme.space.s16}
                shadowLevel={2}
                innerShadow={false}
                style={stageStyles.strip}
              >
                <StageGalleryStrip items={gallery.items} index={gallery.index} enabled={phase === 'open'} phone={false}
                  width={Math.max(STRIP_THUMB_SIZE, window.width - theme.space.s16 * 2)} onSelect={goTo} />
              </GlassPanel>
            )}
          </Animated.View>
        ) : null}
        {annotation && !phone ? (
          <View style={[stageStyles.stripDock, { bottom: theme.space.s16 }]} pointerEvents="box-none">
            <AnnotatorCaptionSlot annotator={annotation.annotator} surface="glass">
              <StageAnnotateCaption
                title={item.title}
                width={annotation.annotator.source.width}
                height={annotation.annotator.source.height}
                editableUntilSend={item.edit !== undefined}
                failure={stageAnnotation.failure !== null}
                bottom={theme.space.s8}
              />
            </AnnotatorCaptionSlot>
          </View>
        ) : null}

        {phone && !annotation && (multiple || item.openFile || item.showInChat || annotatable) ? (
          <View
            style={[
              stageStyles.stripDock,
              { bottom: insets.bottom + theme.space.s24 },
            ]}
            pointerEvents="box-none"
          >
            <StageCapsule>
              {multiple ? (
                // Documents keep their own touch (PDF scroll, video scrub), so paging is a control here too.
                <IconButton
                  variant="plain"
                  iconName="caret-left"
                  accessibilityLabel={t('common.previous')}
                  disabled={!canPrevious}
                  onPress={() => goTo(gallery.index - 1)}
                  testID="media-stage-previous"
                />
              ) : null}
              {counter ? (
                <Text
                  variant="body"
                  style={[
                    stageStyles.phoneCounter,
                    { color: theme.colors.text.secondary },
                    Typography.tabular(),
                  ]}
                >
                  {counter}
                </Text>
              ) : null}
              {multiple ? (
                <IconButton
                  variant="plain"
                  iconName="caret-right"
                  accessibilityLabel={t('common.next')}
                  disabled={!canNext}
                  onPress={() => goTo(gallery.index + 1)}
                  testID="media-stage-next"
                />
              ) : null}
              {annotatable ? (
                <StageAnnotateEntry tooltip={t('files.annotate.annotate')} onPress={enterAnnotate} phone busy={readingFrame} />
              ) : null}
              {item.showInChat ? (
                // The one labelled action (lab pr974 SM1sp); Open file steps down to its glyph beside it.
                <Pressable
                  accessibilityRole="button"
                  onPress={item.showInChat}
                  style={stageStyles.phoneLink}
                  testID="media-stage-show-in-chat"
                >
                  <Text variant="body" emphasis="medium" style={{ color: theme.colors.text.link }}>
                    {t('files.pane.gallery.showInChat')}
                  </Text>
                </Pressable>
              ) : null}
              {item.openFile && item.showInChat ? (
                <IconButton
                  variant="plain"
                  iconName="arrow-square-out"
                  accessibilityLabel={t('files.viewer.openFile')}
                  onPress={item.openFile}
                  testID="media-stage-open-file"
                />
              ) : item.openFile ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={item.openFile}
                  style={stageStyles.phoneLink}
                  testID="media-stage-open-file"
                >
                  <Text
                    variant="body"
                    emphasis="medium"
                    style={{ color: theme.colors.text.link }}
                  >
                    {t('files.viewer.openFile')}
                  </Text>
                </Pressable>
              ) : null}
            </StageCapsule>
          </View>
        ) : null}
      </Animated.View>

      {immersive && immersiveControl && phase === 'open' ? (
        <StageImmersiveExit top={topInset} right={theme.space.s12} onPress={toggleImmersive} />
      ) : null}
    </View>
    </GlassLivePictureBackdropContext.Provider>
    </EscapeLayerProvider>
  );
}

/**
 * While immersive the chrome is gone and a click still zooms, so the way back sits where the control
 * was: invisible until the pointer reaches that corner or it takes keyboard focus. Touch taps the picture.
 */
function StageImmersiveExit(props: Readonly<{ top: number; right: number; onPress: () => void }>) {
  const [shown, setShown] = React.useState(false);
  const show = React.useCallback(() => setShown(true), []);
  const hide = React.useCallback(() => setShown(false), []);
  return (
    <View
      style={[stageStyles.immersiveExit, { top: props.top, right: props.right }, shown ? null : stageStyles.concealed]}
      {...(Platform.OS === 'web' ? { onPointerEnter: show, onPointerLeave: hide } : {})}
      onFocus={show}
      onBlur={hide}
    >
      {/* The immersive backdrop is near-black in every theme, so its one control wears the dark material. */}
      <ScopedTheme name="dark">
      <StageCapsule>
        <IconButton
          variant="plain"
          iconName="arrows-in"
          accessibilityLabel={t('files.viewer.showControls')}
          tooltip={t('files.viewer.showControls')}
          onPress={props.onPress}
          testID="media-stage-immersive-exit"
        />
      </StageCapsule>
      </ScopedTheme>
    </View>
  );
}

const stageStyles = StyleSheet.create((theme) => ({
  viewport: {
    position: 'absolute',
  },
  clip: {
    overflow: 'hidden',
  },
  centre: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  hidden: {
    opacity: 0,
  },
  topBar: {
    position: 'absolute',
    height: TOP_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  title: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: theme.space.s8,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s2,
    padding: theme.space.s4,
  },
  capsulePlaceholder: {
    width: TOP_BAR_HEIGHT,
  },
  capsuleLabelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    height: 36,
    paddingHorizontal: theme.space.s12,
    borderRadius: 18,
  },
  titleSpacer: {
    flex: 1,
  },
  phonePaletteLayer: {
    position: 'absolute',
    left: theme.space.s12,
    right: theme.space.s12,
    gap: theme.space.s8,
  },
  phoneSteps: {
    padding: theme.space.s12,
  },
  stepsLayer: {
    position: 'absolute',
    width: STEPS_PANEL_WIDTH,
  },
  paletteLayer: {
    position: 'absolute',
    height: TOP_BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'box-none',
  },
  zoomLabel: {
    paddingHorizontal: theme.space.s6,
    minWidth: theme.space.s48,
    textAlign: 'center',
  },
  stripDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  strip: {
    padding: theme.space.s4,
  },
  stripRow: {
    flexDirection: 'row',
    gap: theme.space.s4,
  },
  phoneStripRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: PHONE_STRIP.gap,
  },
  phoneThumb: {
    width: PHONE_STRIP.narrow,
    height: PHONE_STRIP.narrowHeight,
    borderRadius: theme.space.s4,
    borderWidth: 0,
    opacity: 0.8,
  },
  phoneThumbWide: {
    width: PHONE_STRIP.wide,
    height: PHONE_STRIP.wideHeight,
    marginHorizontal: PHONE_STRIP.wideMargin,
    borderRadius: theme.space.s6,
  },
  phoneThumbInner: {
    borderRadius: theme.space.s4,
  },
  thumb: {
    width: STRIP_THUMB_SIZE,
    height: STRIP_THUMB_SIZE,
    borderRadius: theme.space.s12,
    borderWidth: STRIP_RING_WIDTH,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  thumbInner: {
    flex: 1,
    borderRadius: theme.space.s10,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.inset,
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  immersiveExit: {
    position: 'absolute',
    height: TOP_BAR_HEIGHT,
    justifyContent: 'center',
  },
  concealed: {
    opacity: 0,
  },
  phoneCounter: {
    paddingHorizontal: theme.space.s12,
  },
  phoneLink: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s6,
  },
}));
