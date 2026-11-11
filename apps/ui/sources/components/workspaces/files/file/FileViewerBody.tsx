import * as React from 'react';
import { View } from 'react-native';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { StyleSheet } from 'react-native-unistyles';

import { FileIcon } from '@/components/ui/media/FileIcon';
import { ImageWell, type ImageWellInfo } from '@/components/ui/media/ImageWell';
import type { PdfPageInfo } from '@/components/ui/media/pdf/PdfViewerStates';
import type { PdfViewPosition } from '@/components/ui/media/pdf/pdfViewPosition';
import type { PdfZoom } from '@/components/ui/media/pdf/pdfZoom';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import type { UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HtmlDocumentFrame, type HtmlDocumentFrameState } from '@/components/ui/surfaces/framed/HtmlDocumentFrame';
import { SessionPaneLazyLoader } from '@/components/sessions/panes/SessionPaneLazyLoader';
import type { FileViewerClass } from '@/scm/utils/filePresentation';
import { t } from '@/text';

import type { FilePageMediaInfo } from './filePageMediaFacts';
import type { MediaPlayerBodyProps } from './MediaPlayerBody';
import type { PdfViewerProps } from '@/components/ui/media/pdf/PdfViewerStates';
import { fileOpenActionLabel } from '@/sync/runtime/files/saveFileBytes';

/** The page's "View full screen" control opens the same stage a press on the picture does. */
export type FileViewerStageHandle = Readonly<{ open: () => void }>;

export type FileViewerBodyProps = Readonly<{
  /** From `resolveFileViewerKind` for this file version. */
  viewer: FileViewerClass;
  title: string;
  /** Preview bytes with the page's cache identity (`buildWorkspacePreviewIdentity`), so the stage reuses them. */
  source: UseFilePreviewSourceInput;
  sizeBytes?: number | null;
  /** SVG or HTML text the page already read for Source / Changes; its Preview renders from it. */
  heldText?: string | null;
  isActive: boolean;
  findSurfaceId: string;
  /** `fill` (default): the body is the page. `inline`: pictures take the column width (Artifact pages). */
  layout?: 'fill' | 'inline';
  /** False where the picture must stay put (a stage already holds it). Default: tap opens the stage. */
  expandable?: boolean;
  openFile?: () => void;
  onDownload?: () => void;
  onOpenInDefaultApp?: () => void;
  /** Hands the file to the viewer chooser's built-in text viewer (binary kinds). */
  onOpenAsText?: () => void;
  onImageInfo?: (info: ImageWellInfo) => void;
  /** A video's or a recording's length (and a video's frame) once its player has loaded it, for the meta row. */
  onMediaInfo?: (info: FilePageMediaInfo) => void;
  /** Set while this kind can open in the Media stage (image, SVG, PDF, video). */
  stageRef?: React.Ref<FileViewerStageHandle | null>;
  pdf?: Readonly<{
    zoom: PdfZoom;
    onZoomChange: (zoom: PdfZoom) => void;
    position?: PdfViewPosition | null;
    onPositionChange?: (position: PdfViewPosition) => void;
    onPageInfo?: (info: PdfPageInfo) => void;
    onFindOpenChange?: (open: boolean) => void;
    showPagePill?: boolean;
  }>;
  testID?: string;
}>;

const loadMediaPlayerBody = () =>
  import('./MediaPlayerBody').then((module) => module.MediaPlayerBody);
const loadPdfViewer = () =>
  import('@/components/ui/media/pdf/PdfViewer').then(
    (module) => module.PdfViewer,
  );

let htmlPreviewGeneration = 0;

/** An HTML file's Preview: the held text, rendered in the shared opaque document sandbox. */
function HtmlPreview(props: Readonly<{ title: string; text: string | null; testID: string }>) {
  const [failedText, setFailedText] = React.useState<string | null>(null);
  const text = props.text;
  // One bundle (and one guest identity) per held text, so a re-read of the same bytes keeps the frame.
  const prepared = React.useMemo(() => (text === null ? null
    : { bundle: artifactHtmlBundleFromBodyV1(text), key: `html-${++htmlPreviewGeneration}` }), [text]);
  const bundle = prepared?.bundle ?? null;
  const state: HtmlDocumentFrameState = bundle === null ? { phase: 'loading' }
    : failedText === text ? { phase: 'failed' } : { phase: 'ready', bundle };
  return (
    <HtmlDocumentFrame
      testID={`${props.testID}:html`}
      frameTestID={`${props.testID}:htmlPreview`}
      frameKey={prepared?.key ?? 'loading'}
      title={props.title}
      state={state}
      onError={() => setFailedText(text)}
      failure={<SurfaceStateCard
        testID={`${props.testID}:htmlPreviewFailed`}
        kind="error"
        size="pane"
        title={t('files.viewer.loadFailed', { name: props.title })}
        action={{ label: t('common.retry'), onPress: () => setFailedText(null) }}
        accessibilitySemantics="alert"
      />}
      loading={<SurfaceStateCard kind="loading" size="pane" title={t('common.loading')} />}
    />
  );
}

/** Binary identity (lab files FV2b): what the file is and what you can do with it. */
function BinaryIdentity(props: FileViewerBodyProps) {
  const kind = t(props.viewer.labelKey as never) as string;
  const facts =
    typeof props.sizeBytes === 'number'
      ? `${kind} · ${formatHappierDataBytes(props.sizeBytes, { kind: 'storage' })}`
      : kind;
  return (
    <View style={styles.page} testID={props.testID}>
      <SurfaceStateCard
        testID={props.testID ? `${props.testID}-identity` : 'file-binary-identity'}
        // Not a failure: the file is what it is, and Download is the one thing to do with it (primary, P2 §3.8).
        kind="empty"
        size="pane"
        icon={<FileIcon fileName={props.title} size={40} appearance="line" />}
        title={props.title}
        reason={facts}
        {...(props.onDownload
          ? {
              action: {
                label: t('files.viewer.download'),
                onPress: props.onDownload,
                testID: props.testID ? `${props.testID}:download` : 'file-binary-download',
              },
            }
          : {})}
        {...(props.onOpenInDefaultApp
          ? {
              secondaryAction: {
                label: fileOpenActionLabel(),
                onPress: props.onOpenInDefaultApp,
              },
            }
          : {})}
        {...(props.onOpenAsText
          ? {
              learnMore: {
                label: t('files.viewer.openAsText'),
                onPress: props.onOpenAsText,
                testID: 'file-binary-open-as-text',
              },
            }
          : {})}
      />
    </View>
  );
}

/**
 * The body for every non-code kind (P2 §3.1): image and SVG wells, PDF, video and audio, binary
 * identity. The File page (P3) and Artifacts mount it; heavy engines load only when that kind opens.
 */
export function FileViewerBody(props: FileViewerBodyProps) {
  const originRef = React.useRef<View | null>(null);
  // Hosts without per-file tab state (Artifacts) still get a working zoom.
  const [localZoom, setLocalZoom] = React.useState<PdfZoom>('fit-width');
  const pdf = props.pdf ?? { zoom: localZoom, onZoomChange: setLocalZoom };
  const { viewer } = props;
  const stage = useMediaStage();
  const stageKind =
    viewer.kind === 'image' || viewer.kind === 'svg' || viewer.kind === 'pdf' || viewer.kind === 'video'
      ? viewer.kind
      : null;
  const openInStage = React.useMemo(() => {
    if (props.expandable === false || !stageKind) return undefined;
    return () =>
      stage.open(
        [
          {
            kind: stageKind,
            title: props.title,
            source: props.source,
            sizeBytes: props.sizeBytes ?? null,
            alphaCapable: viewer.alphaCapable,
            // Documents have no picture rect to fly from; the stage fades them in.
            ...(stageKind === 'image' || stageKind === 'svg' ? { originRef } : {}),
            ...(props.openFile ? { openFile: props.openFile } : {}),
          },
        ],
        0,
      );
  }, [
    props.expandable,
    stage,
    props.openFile,
    props.sizeBytes,
    props.source,
    props.title,
    stageKind,
    viewer.alphaCapable,
  ]);
  React.useImperativeHandle<FileViewerStageHandle | null, FileViewerStageHandle | null>(props.stageRef, () => (openInStage ? { open: openInStage } : null), [openInStage]);

  switch (viewer.kind) {
    case 'image':
    case 'svg':
      return (
        <ImageWell
          kind={viewer.kind}
          title={props.title}
          source={props.source}
          svgText={props.heldText ?? null}
          alphaCapable={viewer.alphaCapable}
          layout={props.layout ?? 'fill'}
          originRef={originRef}
          {...(openInStage ? { onOpenStage: openInStage } : {})}
          {...(props.onImageInfo ? { onImageInfo: props.onImageInfo } : {})}
          {...(props.testID ? { testID: props.testID } : {})}
        />
      );
    case 'video':
    case 'audio':
      return (
        <SessionPaneLazyLoader<MediaPlayerBodyProps>
          testID="file-media-player"
          load={loadMediaPlayerBody}
          props={{
            kind: viewer.kind,
            title: props.title,
            source: props.source,
            isActive: props.isActive,
            ...(props.onMediaInfo ? { onMediaInfo: props.onMediaInfo } : {}),
            ...(props.onDownload ? { onDownload: props.onDownload } : {}),
            ...(props.onOpenInDefaultApp
              ? { onOpenInDefaultApp: props.onOpenInDefaultApp }
              : {}),
            ...(props.testID ? { testID: props.testID } : {}),
          }}
        />
      );
    case 'pdf':
      return (
        <SessionPaneLazyLoader<PdfViewerProps>
          testID="file-pdf-viewer"
          load={loadPdfViewer}
          props={{
            title: props.title,
            source: props.source,
            isActive: props.isActive,
            findSurfaceId: props.findSurfaceId,
            ...pdf,
            ...(props.onOpenInDefaultApp
              ? { onOpenInDefaultApp: props.onOpenInDefaultApp }
              : {}),
            ...(props.testID ? { testID: props.testID } : {}),
          }}
        />
      );
    case 'html':
      return <HtmlPreview title={props.title} text={props.heldText ?? null} testID={props.testID ?? 'file-viewer-body'} />;
    default:
      return <BinaryIdentity {...props} />;
  }
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    alignSelf: 'stretch',
    justifyContent: 'center',
    padding: theme.space.s32,
  },
}));
