import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { formatPreviewProgressMegabytes } from '@/components/ui/media/MediaDownloadProgress';
import type { FilePreviewProgress, FilePreviewSourceState, UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { PdfViewPosition } from './pdfViewPosition';
import type { PdfZoom } from './pdfZoom';
import { fileOpenActionLabel } from '@/sync/runtime/files/saveFileBytes';

/** How long the page pill stays after the reader stops scrolling (lab files FV5). */
export const PDF_PAGE_PILL_IDLE_MS = 1200;
/** The stage's reading column for a PDF item (lab files MS1f: page width = min(viewport − 64, 680)). */
export const PDF_STAGE_COLUMN_MAX = 680;

export type PdfPageInfo = Readonly<{ page: number; total: number }>;

export type PdfViewerProps = Readonly<{
  title: string;
  source: UseFilePreviewSourceInput;
  isActive: boolean;
  /** The shared Find registration id (one per mounted viewer). */
  findSurfaceId: string;
  /** Controlled zoom; the page header's zoom menu and the per-file tab state own it. */
  zoom: PdfZoom;
  onZoomChange: (zoom: PdfZoom) => void;
  /** Restored on open, persisted on leave (details-tab state). */
  position?: PdfViewPosition | null;
  onPositionChange?: (position: PdfViewPosition) => void;
  onPageInfo?: (info: PdfPageInfo) => void;
  /** Whether the viewer's own Find bar is showing, reported like page info (the phone toolbar steps aside). */
  onFindOpenChange?: (open: boolean) => void;
  /** The floating page pill; phones show the page in their bottom toolbar instead. */
  showPagePill?: boolean;
  /** `stage`: pages stand on the Media stage's own backdrop in a reading column (lab MS1f). */
  presentation?: 'page' | 'stage';
  onOpenInDefaultApp?: () => void;
  /** Reports the body's owned preview for stage handoffs without admitting a second source. */
  onPreviewChange?: (preview: FilePreviewSourceState) => void;
  testID?: string;
}>;

export type PdfViewerFailure = 'protected' | 'invalid' | 'failed';

/** Protected and damaged PDFs share one calm page that hands off; failures keep the frame and retry. */
export function PdfViewerFailureState(
  props: Readonly<{
    failure: PdfViewerFailure;
    title: string;
    diagnosticCode?: string | null;
    onRetry: () => void;
    onOpenInDefaultApp?: () => void;
  }>,
) {
  const handoff = props.onOpenInDefaultApp
    ? {
        action: {
          label: fileOpenActionLabel(),
          onPress: props.onOpenInDefaultApp,
        },
      }
    : {};
  if (props.failure === 'protected' || props.failure === 'invalid') {
    return (
      <SurfaceStateCard
        testID={`pdf-viewer-${props.failure}`}
        kind="unavailable"
        size="pane"
        {...(props.failure === 'protected' ? { iconName: 'lock' as const } : {})}
        title={
          props.failure === 'protected'
            ? t('files.viewer.pdfProtectedTitle')
            : t('files.viewer.pdfDamagedTitle')
        }
        reason={
          props.failure === 'protected'
            ? t('files.viewer.pdfProtectedBody')
            : t('files.viewer.pdfDamagedBody')
        }
        {...handoff}
      />
    );
  }
  return (
    <SurfaceStateCard
      testID="pdf-viewer-failed"
      kind="error"
      size="pane"
      title={t('files.viewer.pdfFailed')}
      diagnosticCode={props.diagnosticCode ?? null}
      action={{ label: t('common.retry'), onPress: props.onRetry }}
    />
  );
}

/**
 * The PDF's first wait. Once bytes flow, the pane's live line names them and offers Cancel
 * ("Loading PDF · 0.7 of 1.8 MB", lab files FV5l); before that, the calm loading card.
 */
export function PdfViewerLoadingState(
  props: Readonly<{
    progress?: FilePreviewProgress | null;
    onCancel: () => void;
    /** Native: the overlay hides the WebView while it boots. */
    covers?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const background = props.covers ? { backgroundColor: theme.colors.surface.inset } : null;
  if (props.progress) {
    return (
      <View style={[StyleSheet.absoluteFill, background]} pointerEvents="box-none">
        <SurfaceFreshnessLine
          testID="pdf-viewer-loading"
          busy
          reason={`${t('files.viewer.pdfLoading')} · ${t('files.viewer.megabytesOf', formatPreviewProgressMegabytes(props.progress))}`}
          action={{ label: t('common.cancel'), onPress: props.onCancel, testID: 'pdf-viewer-loading-cancel' }}
        />
      </View>
    );
  }
  return (
    <View style={[StyleSheet.absoluteFill, styles.centred, background]} pointerEvents="none">
      <SurfaceStateCard
        testID="pdf-viewer-loading"
        kind="loading"
        size="pane"
        title={t('files.viewer.pdfLoading')}
      />
    </View>
  );
}

/** "3 / 14" while the reader moves; it settles away after a pause and never takes input. */
export function PdfPagePill(
  props: Readonly<{
    info: PdfPageInfo | null;
    zoomPercent: number | null;
    tick: number;
  }>,
) {
  const { theme } = useUnistyles();
  const opacity = useSharedValue(0);
  React.useEffect(() => {
    if (!props.info || props.tick === 0) return;
    opacity.value = withTiming(1, { duration: motionTokens.durationMs.fast });
    const timer = setTimeout(() => {
      opacity.value = withTiming(0, { duration: motionTokens.durationMs.base });
    }, PDF_PAGE_PILL_IDLE_MS);
    return () => clearTimeout(timer);
  }, [opacity, props.info, props.tick]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  if (!props.info) return null;
  const label = t('files.viewer.pdfPage', {
    page: props.info.page,
    total: props.info.total,
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.pillDock, { bottom: theme.space.s16 }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <GlassPanel shadowLevel={2} innerShadow={false} style={styles.pill}>
        <Text
          variant="meta"
          emphasis="semiBold"
          style={[{ color: theme.colors.text.primary }, Typography.tabular()]}
        >
          {label}
        </Text>
        {props.zoomPercent !== null ? (
          <Text
            variant="meta"
            style={[
              { color: theme.colors.text.secondary },
              Typography.tabular(),
            ]}
          >
            {` · ${t('files.viewer.zoomPercent', { percent: props.zoomPercent })}`}
          </Text>
        ) : null}
      </GlassPanel>
    </Animated.View>
  );
}

export function PdfViewerFrame(
  props: Readonly<{ children: React.ReactNode; testID?: string; presentation?: 'page' | 'stage' }>,
) {
  // The page pill and the Find bar float over the paper (arbitrary pixels), so their glass takes the
  // live-picture coat: dark-theme ink stays readable over a white page at the default.
  return (
    <GlassLivePictureBackdropContext.Provider value>
      <View testID={props.testID} style={[styles.frame, props.presentation === 'stage' ? styles.stageFrame : null]}>
        {props.children}
      </View>
    </GlassLivePictureBackdropContext.Provider>
  );
}

const styles = StyleSheet.create((theme) => ({
  centred: {
    justifyContent: 'center',
  },
  stageFrame: {
    backgroundColor: 'transparent',
    alignSelf: 'center',
    width: '100%',
    maxWidth: PDF_STAGE_COLUMN_MAX + theme.space.s16 * 2,
  },
  frame: {
    flex: 1,
    alignSelf: 'stretch',
    minHeight: 0,
    backgroundColor: theme.colors.surface.inset,
    justifyContent: 'center',
  },
  pillDock: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s4,
  },
}));
