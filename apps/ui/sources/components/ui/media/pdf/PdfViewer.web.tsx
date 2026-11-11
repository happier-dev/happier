import * as React from 'react';
import { View, type TextInput } from 'react-native';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useUnistyles } from 'react-native-unistyles';

import { FindBar } from '@/components/ui/find/FindBar';
import {
  FindBarPlacement,
  useFindBarPresence,
} from '@/components/ui/find/FindBarPlacement';
import { t } from '@/text';

import { MediaLoadStoppedState } from '../MediaDownloadProgress';
import { useFilePreviewSource } from '../useFilePreviewSource';
import {
  createWebPdfDocumentLoader,
  loadPdfjs,
  readPdfBlobBytes,
} from './loadPdfjs.web';
import {
  createPdfCanvasViewer,
  type PdfTextLayerFactory,
} from './pdfCanvasViewer';
import { buildPdfPageCss } from './pdfPageCss';
import { createPdfViewPosition } from './pdfViewPosition';
import { isUnrenderedLayoutBox } from '@/components/ui/presentation/retainedPresentationGeometry';
import { readPdfViewport, resolvePdfScale, type PdfZoom } from './pdfZoom';
import { usePdfFind } from './usePdfFind';
import {
  PdfPagePill,
  PdfViewerFailureState,
  PdfViewerFrame,
  PdfViewerLoadingState,
  type PdfPageInfo,
  type PdfViewerFailure,
  type PdfViewerProps,
} from './PdfViewerStates';
import { fileOpenActionLabel } from '@/sync/runtime/files/saveFileBytes';

type Viewer = ReturnType<typeof createPdfCanvasViewer>;
type Loader = Awaited<ReturnType<typeof createWebPdfDocumentLoader>>;
type BodyState =
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready' }>
  | Readonly<{
      status: 'error';
      failure: PdfViewerFailure;
      code: string | null;
    }>;

const STYLE_ELEMENT_ID = 'happier-pdf-page-css';
const SCOPE = '[data-pdf-viewer]';

function usePdfPageStylesheet() {
  const { theme } = useUnistyles();
  const css = buildPdfPageCss(
    SCOPE,
    {
      well: theme.colors.surface.inset,
      paper: theme.colors.overlay.mediaPaper,
      hairline: theme.colors.border.default,
      matchAll: theme.colors.find.matchAll,
      matchCurrent: theme.colors.find.matchCurrent,
    },
    { gap: theme.space.s16 },
  );
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    let element = document.getElementById(
      STYLE_ELEMENT_ID,
    ) as HTMLStyleElement | null;
    if (!element) {
      element = document.createElement('style');
      element.id = STYLE_ELEMENT_ID;
      document.head.append(element);
    }
    if (element.textContent !== css) element.textContent = css;
  }, [css]);
}

/**
 * The web / Tauri PDF body (P2 §3.7, lab files FV5): continuous pdf.js pages on paper, Find through
 * the shared registration, zoom from the page header, the page pill while reading. The engine
 * (`createPdfCanvasViewer`, loader, find model) owns lifetimes; this owns states and chrome.
 */
export function PdfViewer(props: PdfViewerProps) {
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  return <PdfViewerBody key={attempt} {...props} onRetry={retry} />;
}

// Keep the original source/cache identity while restarting its consumer on an explicit retry.
function PdfViewerBody(props: PdfViewerProps & Readonly<{ onRetry(): void }>) {
  usePdfPageStylesheet();
  // Cancel stops the transfer until the person loads again (lab FV5l: the page keeps its hand-off).
  const [stopped, setStopped] = React.useState(false);
  const preview = useFilePreviewSource({
    ...props.source,
    enabled: props.source.enabled && props.isActive && !stopped,
  });
  const containerRef = React.useRef<View>(null);
  const viewerRef = React.useRef<Viewer | null>(null);
  const firstPage = React.useRef<Readonly<{
    width: number;
    height: number;
  }> | null>(null);
  const [state, setState] = React.useState<BodyState>({ status: 'loading' });
  const [document, setDocument] = React.useState<PDFDocumentProxy | null>(null);
  const [pageInfo, setPageInfo] = React.useState<PdfPageInfo | null>(null);
  const [pillTick, setPillTick] = React.useState(0);
  const [scale, setScale] = React.useState<number | null>(null);
  const latest = React.useRef(props);
  latest.current = props;
  const positionRef = React.useRef<ReturnType<typeof createPdfViewPosition> | null>(null);
  // The tab holds one place for every viewer of it: one written by another viewer (the phone page) moves this one there.
  const tabPage = props.position?.page;
  const tabTop = props.position?.top;
  const tabLeft = props.position?.left;
  React.useEffect(() => {
    if (tabPage === undefined || tabTop === undefined || tabLeft === undefined) return;
    positionRef.current?.adopt({ page: tabPage, top: tabTop, left: tabLeft });
  }, [tabLeft, tabPage, tabTop]);
  const progress = preview.status === 'loading' ? preview.progress : undefined;
  const byteLength = preview.status === 'loaded' ? preview.byteLength : undefined;
  const mimeType = preview.status === 'loaded' ? preview.mimeType : undefined;
  React.useEffect(() => {
    props.onPreviewChange?.(preview);
    // Loading states are transient objects; report their facts without feeding render identity back to the stage.
  }, [props.onPreviewChange, preview.status, preview.uri, preview.error, progress?.receivedBytes, progress?.totalBytes, byteLength, mimeType]);

  const element = () => containerRef.current as unknown as HTMLElement | null;
  const scaleFor = React.useCallback((mode: PdfZoom = latest.current.zoom) => {
    const node = element();
    const page = firstPage.current;
    if (!node || !page) return 1;
    return resolvePdfScale(mode, {
      pageWidth: page.width,
      pageHeight: page.height,
      ...readPdfViewport(node),
    });
  }, []);
  const applyScale = React.useCallback((next: number) => {
    element()?.style.setProperty('--total-scale-factor', String(next));
    setScale(next);
  }, []);

  React.useEffect(() => {
    if (preview.status !== 'loaded') return;
    const uri = preview.uri;
    const controller = new AbortController();
    let loader: Loader | null = null;
    let position: ReturnType<typeof createPdfViewPosition> | null = null;
    setState({ status: 'loading' });
    const textLayer: PdfTextLayerFactory = async (
      page,
      viewport,
      container,
    ) => {
      const pdfjs = await loadPdfjs();
      const content = await page.getTextContent();
      const layer = new pdfjs.TextLayer({
        textContentSource: content,
        container,
        viewport,
      });
      return {
        render: () => layer.render(),
        cancel: () => layer.cancel(),
        get textDivs() {
          return layer.textDivs;
        },
        items: content.items,
      };
    };
    const attach = (next: PDFDocumentProxy | null, signal?: AbortSignal) => {
      // A viewer laid out at no height (its page hidden at another width) has no place of its own to keep.
      if (viewerRef.current && (element()?.clientHeight ?? 0) > 0)
        position?.locationChanged(viewerRef.current.getViewPosition());
      position?.dispose();
      position = null;
      positionRef.current = null;
      viewerRef.current?.dispose();
      viewerRef.current = null;
      setDocument(next);
      if (!next) return;
      void next
        .getPage(1)
        .then((page) => {
          const container = element();
          if (signal?.aborted || !container) return;
          const viewport = page.getViewport({ scale: 1 });
          firstPage.current = {
            width: viewport.width,
            height: viewport.height,
          };
          const initialScale = scaleFor();
          applyScale(initialScale);
          position = createPdfViewPosition({
            initial: latest.current.position ?? null,
            restore: (value) => viewerRef.current?.restorePosition(value),
            persist: (value) => latest.current.onPositionChange?.(value),
          });
          positionRef.current = position;
          const viewer = createPdfCanvasViewer({
            container,
            document: next,
            scale: initialScale,
            signal,
            createTextLayer: textLayer,
            onPageChange: (current) => {
              setPageInfo({ page: current, total: next.numPages });
              setPillTick((value) => value + 1);
            },
            onError: () =>
              setState({
                status: 'error',
                failure: 'failed',
                code: 'pdf_render_failed',
              }),
            onReaderMove: () => position?.readerMoved(),
            onLocationChange: (value) => {
              position?.locationChanged(value);
            },
            onPagesInit: (count) => position?.pagesInit(count),
            onPagesLoaded: (count) => position?.pagesLoaded(count),
            fitScale: () => scaleFor('fit-width'),
            onScaleChange: (value, zoom) => {
              applyScale(value);
              latest.current.onZoomChange(zoom);
            },
          });
          viewerRef.current = viewer;
          void viewer.ready.then(() => {
            if (signal?.aborted) return;
            setPageInfo({ page: 1, total: next.numPages });
            // The pill says the page count and zoom once on opening, then fades until the reader moves.
            setPillTick((value) => value + 1);
            setState({ status: 'ready' });
          });
        })
        .catch(() => {
          if (!signal?.aborted)
            setState({
              status: 'error',
              failure: 'failed',
              code: 'pdf_first_page_failed',
            });
        });
    };
    void (async () => {
      try {
        loader = await createWebPdfDocumentLoader(attach);
        if (controller.signal.aborted) {
          void loader.dispose();
          return;
        }
        const bytes = await readPdfBlobBytes(uri, controller.signal);
        const result = await loader.load(bytes);
        if (result.status === 'error')
          setState({
            status: 'error',
            failure: result.reason,
            code: result.reason === 'failed' ? 'pdf_load_failed' : null,
          });
      } catch (error) {
        if (!controller.signal.aborted)
          setState({
            status: 'error',
            failure: 'failed',
            code: error instanceof Error ? error.name : 'pdf_load_failed',
          });
      }
    })();
    return () => {
      controller.abort();
      void loader?.dispose();
    };
  }, [applyScale, preview.status, preview.uri, scaleFor]);

  // The header's zoom menu sets the absolute scale.
  React.useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || state.status !== 'ready') return;
    const next = scaleFor();
    viewer.setScale(next);
    applyScale(next);
  }, [applyScale, props.zoom, scaleFor, state.status]);
  // A fit mode follows the column: the pane or window narrowing or widening re-fits the pages. A chosen
  // percentage stays as chosen (the column scrolls). The column resizes without the window on web (panes).
  React.useEffect(() => {
    const node = element();
    if (!node || state.status !== 'ready' || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const viewer = viewerRef.current;
      if (!viewer || typeof latest.current.zoom === 'number') return;
      // A hidden retained pane is not a narrower column: keep the pages at their fitted scale.
      const box = entries.at(-1)?.contentRect;
      if (box && isUnrenderedLayoutBox(node, box.width, box.height)) return;
      const next = scaleFor();
      viewer.setScale(next);
      applyScale(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [applyScale, scaleFor, state.status]);

  const { onPageInfo } = props;
  React.useEffect(() => {
    if (pageInfo) onPageInfo?.(pageInfo);
  }, [onPageInfo, pageInfo]);

  const input = React.useRef<TextInput | null>(null);
  const [inputFocused, setInputFocused] = React.useState(false);
  const find = usePdfFind({
    surfaceId: props.findSurfaceId,
    document,
    active: props.isActive && state.status === 'ready',
    containsFocus: () => {
      const node = element();
      return Boolean(
        node &&
        typeof window !== 'undefined' &&
        window.document.activeElement &&
        node.parentElement?.contains(window.document.activeElement),
      );
    },
    isInputFocused: () => inputFocused,
    reveal: (match) => viewerRef.current?.revealMatch(match),
    focusInput: () => input.current?.focus(),
  });
  React.useEffect(() => {
    viewerRef.current?.setFindMatches(
      find.snapshot.matches,
      find.snapshot.current,
    );
  }, [find.snapshot.current, find.snapshot.matches]);
  const shown = find.snapshot.open && props.isActive;
  const presence = useFindBarPresence(shown);
  const { onFindOpenChange } = props;
  React.useEffect(() => {
    onFindOpenChange?.(shown);
  }, [onFindOpenChange, shown]);

  const failed =
    state.status === 'error'
      ? state
      : preview.status === 'error'
        ? { failure: 'failed' as const, code: preview.error }
        : null;
  const percent = scale !== null ? Math.round(scale * 100) : null;
  return (
    <PdfViewerFrame testID={props.testID} presentation={props.presentation}>
      <View
        ref={containerRef}
        {...({ dataSet: { pdfViewer: props.presentation ?? 'page' } } as unknown as Record<string, unknown>)}
        tabIndex={0}
        accessibilityLabel={props.title}
        style={{ flex: 1, minHeight: 0, display: failed || stopped ? 'none' : 'flex' }}
      />
      {stopped ? (
        <MediaLoadStoppedState
          testID="pdf-viewer-stopped"
          title={props.title}
          onLoadAgain={props.onRetry}
          {...(props.onOpenInDefaultApp
            ? { handoff: { label: fileOpenActionLabel(), onPress: props.onOpenInDefaultApp } }
            : {})}
        />
      ) : failed ? (
        <PdfViewerFailureState
          failure={failed.failure}
          title={props.title}
          diagnosticCode={failed.code}
          onRetry={props.onRetry}
          onOpenInDefaultApp={props.onOpenInDefaultApp}
        />
      ) : state.status === 'loading' ? (
        <PdfViewerLoadingState
          progress={preview.status === 'loading' ? preview.progress : null}
          onCancel={() => setStopped(true)}
        />
      ) : null}
      {props.showPagePill !== false && state.status === 'ready' ? (
        <PdfPagePill info={pageInfo} zoomPercent={percent} tick={pillTick} />
      ) : null}
      {presence.present ? (
        <FindBarPlacement visible={shown}>
          {(presentation) => (
            <FindBar
              query={find.snapshot.query}
              options={find.snapshot.options}
              status={find.snapshot.status}
              capabilities={find.controller.capabilities}
              surfaceLabel={t('find.surface.file')}
              presentation={presentation}
              autoFocus
              inputRef={input}
              onInputFocus={() => setInputFocused(true)}
              onInputBlur={() => setInputFocused(false)}
              onQueryChange={find.controller.setQuery}
              onOptionsChange={find.controller.setOptions}
              onStep={find.controller.step}
              onStop={find.controller.stop}
              onClose={find.controller.close}
              testID="pdf-viewer-find"
            />
          )}
        </FindBarPlacement>
      ) : null}
    </PdfViewerFrame>
  );
}
